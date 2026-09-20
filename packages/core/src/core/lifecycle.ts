import type { Express } from "express";
import { createServer, Server } from "http";
import { Execution, ExecutionContext, ExecutionError, ExecutionIdentity, ExecutionOptions, duration } from "./execution";
import { SetupContext, setupLifecycle } from "./setupContext";

export interface ApplicationOptions {
    /** A snapshot is passed to +config.load; defaults to this process's environment. */
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly executionTimeoutMs?: number;
    readonly shutdownGraceMs?: number;
    readonly shutdownTimeoutMs?: number;
}
export interface ExecutionScope<Services, Identity extends ExecutionIdentity = ExecutionIdentity> {
    readonly execution: ExecutionContext<Identity>;
    readonly services: Readonly<Services>;
}
export class LifecycleError extends Error {
    constructor(message: string, public readonly errors: readonly unknown[]) {
        super(message);
        this.name = "LifecycleError";
    }
}
export class ShutdownTimeoutError extends Error {
    constructor() { super("Shutdown timed out; resources remain owned until active executions and cleanup settle"); this.name = "ShutdownTimeoutError"; }
}

/** One owner per application, independent of process signals and other instances. */
export class ApplicationRuntime<Services extends object = Record<string, unknown>> {
    private status: "ready" | "draining" | "closed" = "ready";
    private readonly active = new Set<Execution>();
    private readonly idle = new Set<() => void>();
    private readonly servers = new Set<Server>();
    private shutdown?: Promise<void>;
    private completion?: Promise<void>;
    private readonly executionTimeout: number;
    private readonly shutdownGrace: number;
    private readonly shutdownTimeout: number;

    constructor(readonly http: Express, private readonly setup: SetupContext, options: ApplicationOptions) {
        this.executionTimeout = duration(options.executionTimeoutMs ?? 30000, "Execution timeout");
        this.shutdownGrace = duration(options.shutdownGraceMs ?? 5000, "Shutdown grace");
        this.shutdownTimeout = duration(options.shutdownTimeoutMs ?? 10000, "Shutdown timeout");
        if (this.shutdownTimeout < this.shutdownGrace) throw new RangeError("Shutdown timeout must be at least the grace period");
    }
    get state(): "ready" | "draining" | "closed" { return this.status; }
    get ready(): boolean { return this.status === "ready"; }
    /** Actual completion, including cleanup after a close() timeout. */
    get closed(): Promise<void> { return this.completion ?? Promise.reject(new Error("Call close() before awaiting closed")); }

    begin(options: Partial<ExecutionOptions> = {}): Execution {
        if (!this.ready) throw new ExecutionError("unavailable", "Application is not accepting executions");
        const execution = new Execution(this.executionTimeout, options);
        this.active.add(execution);
        return execution;
    }
    finish(execution: Execution): void {
        execution.end();
        this.active.delete(execution);
        if (!this.active.size) for (const resolve of this.idle) resolve();
    }
    async execute<Identity extends ExecutionIdentity, Result>(options: ExecutionOptions<Identity>, operation: (scope: ExecutionScope<Services, Identity>) => Result | Promise<Result>): Promise<Result> {
        if (!options.identity) throw new TypeError("Controlled executions require an explicit identity");
        const execution = this.begin(options);
        try {
            execution.context.throwIfAborted();
            const result = await operation(Object.freeze({ execution: execution.context as ExecutionContext<Identity>, services: this.setup.services as Readonly<Services> }));
            execution.context.throwIfAborted();
            return result;
        } finally { this.finish(execution); }
    }
    /** Own an HTTP listener, including listeners around a custom Express parent. */
    async listen(port = 4040, handler: Express = this.http): Promise<Server> {
        if (!this.ready) throw new ExecutionError("unavailable", "Application is not accepting listeners");
        const server = createServer(handler);
        this.servers.add(server);
        try {
            await new Promise<void>((resolve, reject) => {
                const cleanup = () => {
                    server.off("error", error);
                    server.off("listening", listening);
                    server.off("close", closed);
                };
                const error = (cause: unknown) => { cleanup(); reject(cause); };
                const listening = () => { cleanup(); resolve(); };
                const closed = () => error(new ExecutionError("unavailable", "HTTP listener closed during startup"));
                server.once("error", error);
                server.once("listening", listening);
                server.once("close", closed);
                try { server.listen(port); } catch (cause) { error(cause); }
            });
            if (!this.ready) { server.close(); throw new ExecutionError("unavailable", "Application shut down while listening"); }
            return server;
        } catch (error) {
            this.servers.delete(server);
            try { await this.close(); } catch (cleanup) { throw new LifecycleError("Listener startup and cleanup failed", [error, cleanup]); }
            throw error;
        }
    }
    close(): Promise<void> {
        if (this.shutdown) return this.shutdown;
        this.status = "draining";
        const stopped = Promise.allSettled([...this.servers].map(server => new Promise<void>((resolve, reject) => {
            server.close(error => error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve());
            server.closeIdleConnections?.();
        })));
        const drained = this.active.size ? new Promise<void>(resolve => this.idle.add(resolve)) : Promise.resolve();
        const abort = setTimeout(() => {
            for (const execution of this.active) execution.abort(new ExecutionError("cancelled", "Application shutdown"));
        }, this.shutdownGrace);
        this.completion = (async () => {
            const errors: unknown[] = [];
            await drained;
            clearTimeout(abort);
            this.idle.clear();
            // No application code is using resources now. Close leftover HTTP sockets.
            for (const server of this.servers) server.closeAllConnections?.();
            for (const result of await stopped) if (result.status === "rejected") errors.push(result.reason);
            try { await setupLifecycle(this.setup).dispose(); } catch (error) { errors.push(error); }
            this.status = "closed";
            if (errors.length) throw new LifecycleError("Application shutdown failed", errors);
        })();
        // A bounded caller wait never frees resources underneath non-cooperative work.
        this.shutdown = new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new ShutdownTimeoutError()), this.shutdownTimeout);
            this.completion!.then(() => { clearTimeout(timeout); resolve(); }, error => { clearTimeout(timeout); reject(error); });
        });
        return this.shutdown;
    }
}

/** Public owner handle. Internal admission and completion are framework-only. */
export type Application<Services extends object = Record<string, unknown>> = Pick<ApplicationRuntime<Services>, "http" | "execute" | "listen" | "close" | "closed" | "state" | "ready">;
