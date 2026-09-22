import type { Express } from "express";
import { createServer, Server } from "http";
import { Execution, ExecutionContext, ExecutionError, ExecutionIdentity, ExecutionOptions, duration } from "./execution";
import { SetupContext, setupLifecycle } from "./setupContext";
import type { DeliveryKind, EventMetadata, EventReceipt, ScheduleOccurrence } from "./triggers";
import type { JsonValue } from "./jobs";
import type { JobAttemptResult, WorkerOptions } from "./jobs";
import type { ExecutionKind, HealthReport, MetricSnapshot, OperationalAttributes, ReadinessReport } from "./operations";

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
function uniqueLifecycleErrors(errors: readonly unknown[], seen: WeakSet<object>): readonly unknown[] {
    const unique: unknown[] = [];
    for (const error of errors) {
        const hasIdentity = (typeof error === "object" && error !== null) || typeof error === "function";
        if (!hasIdentity) { unique.push(error); continue; }
        if (seen.has(error as object)) continue;
        seen.add(error as object);
        if (error instanceof LifecycleError) {
            const nested = uniqueLifecycleErrors(error.errors, seen);
            if (error.errors.length && !nested.length) continue;
            const unchanged = nested.length === error.errors.length && nested.every((value, index) => value === error.errors[index]);
            unique.push(unchanged ? error : new LifecycleError(error.message, nested));
        } else unique.push(error);
    }
    return unique.length === errors.length && unique.every((value, index) => value === errors[index]) ? errors : unique;
}
export class LifecycleError extends Error {
    constructor(message: string, public readonly errors: readonly unknown[]) {
        super(message);
        this.name = "LifecycleError";
        this.errors = uniqueLifecycleErrors(errors, new WeakSet<object>());
    }
}
export class ShutdownTimeoutError extends Error {
    constructor() { super("Shutdown timed out; resources remain owned until active executions and cleanup settle"); this.name = "ShutdownTimeoutError"; }
}
function deferredPromise<T>(): { readonly promise: Promise<T>; resolve(value: T | PromiseLike<T>): void; reject(error: unknown): void } {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((fulfilled, rejected) => { resolve = fulfilled; reject = rejected; });
    return { promise, resolve, reject };
}

/** One owner per application, independent of process signals and other instances. */
export class ApplicationRuntime<Services extends object = Record<string, unknown>> {
    private status: "ready" | "draining" | "closed" = "ready";
    private readonly active = new Set<Execution>();
    private readonly idle = new Set<() => void>();
    private readonly servers = new Map<Server, { readonly runtimeError: (error: unknown) => void }>();
    private readonly listenerFailures: unknown[] = [];
    private readonly background = new Set<Promise<unknown>>();
    private readonly wakeLoops = new Set<() => void>();
    private readonly working = new Set<string>();
    private readonly observed = new WeakMap<Execution, (status: "ok" | "error" | "cancelled") => void>();
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

    begin(options: Partial<ExecutionOptions> = {}, kind: ExecutionKind = "http", links: readonly string[] = [], attributes: OperationalAttributes = {}): Execution {
        if (!this.ready) throw new ExecutionError("unavailable", "Application is not accepting executions");
        const execution = new Execution(this.executionTimeout, options);
        this.active.add(execution);
        this.observed.set(execution, setupLifecycle(this.setup).operations.executionStarted(kind, execution.context.correlationId, links, attributes));
        return execution;
    }
    finish(execution: Execution, status: "ok" | "error" | "cancelled" = "ok"): void {
        this.observed.get(execution)?.(status);
        this.observed.delete(execution);
        execution.end();
        this.active.delete(execution);
        if (!this.active.size) for (const resolve of this.idle) resolve();
    }
    async execute<Identity extends ExecutionIdentity, Result>(options: ExecutionOptions<Identity>, operation: (scope: ExecutionScope<Services, Identity>) => Result | Promise<Result>): Promise<Result> {
        return this.executeObserved("controlled", options, operation);
    }
    /** Framework-internal variant used by named entry points to preserve one execution context and bounded labels. */
    async executeObserved<Identity extends ExecutionIdentity, Result>(kind: ExecutionKind, options: ExecutionOptions<Identity>, operation: (scope: ExecutionScope<Services, Identity>) => Result | Promise<Result>,
        links: readonly string[] = [], attributes: OperationalAttributes = {}): Promise<Result> {
        if (!options.identity) throw new TypeError("Controlled executions require an explicit identity");
        const execution = this.begin(options, kind, links, attributes);
        let status: "ok" | "error" | "cancelled" = "ok";
        try {
            execution.context.throwIfAborted();
            const result = await operation(Object.freeze({ execution: execution.context as ExecutionContext<Identity>, services: this.setup.services as Readonly<Services> }));
            execution.context.throwIfAborted();
            return result;
        } catch (error) {
            status = error instanceof ExecutionError && ["cancelled", "deadline"].includes(error.code) ? "cancelled" : "error";
            throw error;
        } finally { this.finish(execution, status); }
    }
    /** One delivery, including claim, heartbeat and acknowledgement, owned until actual settlement. */
    runJob(options: WorkerOptions & { kind?: DeliveryKind } = {}): Promise<JobAttemptResult | undefined> {
        if (!this.ready) return Promise.reject(new ExecutionError("unavailable", "Application is not accepting jobs"));
        const lifecycle = setupLifecycle(this.setup);
        const pending = Promise.resolve().then(() => options.kind === "publication" ? lifecycle.publications.attempt(this, options) :
            options.kind && options.kind !== "job" ? lifecycle.triggers.attempt(this, options.kind, options) : lifecycle.jobs.attempt(this, options));
        this.background.add(pending);
        void pending.finally(() => this.background.delete(pending)).catch(() => {});
        return pending;
    }
    private own<Result>(pending: Promise<Result>): Promise<Result> {
        this.background.add(pending);
        void pending.finally(() => this.background.delete(pending)).catch(() => {});
        return pending;
    }
    acceptEvent(options: ExecutionOptions, event: EventMetadata & { readonly payload: unknown }): Promise<EventReceipt> {
        if (!this.ready) return Promise.reject(new ExecutionError("unavailable", "Application is closing"));
        return this.own(setupLifecycle(this.setup).triggers.accept(this, options, event));
    }
    tick(): Promise<readonly ScheduleOccurrence[]> {
        if (!this.ready) return Promise.reject(new ExecutionError("unavailable", "Application is closing"));
        return this.own(setupLifecycle(this.setup).triggers.tick(this));
    }
    command(name: string, input: unknown, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<JsonValue> {
        if (!this.ready) return Promise.reject(new ExecutionError("unavailable", "Application is closing"));
        return this.own(setupLifecycle(this.setup).triggers.command(this, name, input, options));
    }
    private pause(poll: number): Promise<void> {
        return new Promise(resolve => {
            const wake = () => { clearTimeout(timer); this.wakeLoops.delete(wake); resolve(); };
            const timer = setTimeout(wake, poll);
            this.wakeLoops.add(wake);
        });
    }
    async schedule(options: { pollIntervalMs?: number } = {}): Promise<void> {
        if (!this.ready || this.working.has("scheduler")) throw new ExecutionError("unavailable", "Scheduler already running or application closing");
        const poll = duration(options.pollIntervalMs ?? 1000, "Scheduler poll interval");
        this.working.add("scheduler");
        try { while (this.ready) { await this.tick(); if (this.ready) await this.pause(poll); } }
        finally { this.working.delete("scheduler"); }
    }
    /** Sequential worker; scale with independent processes. No HTTP listener or global signals. */
    async work(options: WorkerOptions & { kind?: DeliveryKind } = {}): Promise<void> {
        if (!this.ready || this.working.has(options.kind ?? "job")) throw new ExecutionError("unavailable", "Worker is already running or application is closing");
        const poll = duration(options.pollIntervalMs ?? 1000, "Worker poll interval");
        this.working.add(options.kind ?? "job");
        try {
            while (this.ready) {
                const result = await this.runJob(options);
                if (!result && this.ready) await this.pause(poll);
            }
        } finally { this.working.delete(options.kind ?? "job"); }
    }
    /** Process liveness is independent of infrastructure readiness. */
    health(): HealthReport { return setupLifecycle(this.setup).operations.health(this.state); }
    /** Readiness combines admission state with every setup-registered required-infrastructure probe. */
    readiness(): Promise<ReadinessReport> {
        const pending = setupLifecycle(this.setup).operations.readinessReport(() => this.state);
        return this.ready ? this.own(pending) : pending;
    }
    /** Framework-owned bounded-cardinality counters and duration aggregates. */
    metrics(): readonly MetricSnapshot[] { return setupLifecycle(this.setup).operations.metrics(); }
    /** Own an HTTP listener, including listeners around a custom Express parent. */
    async listen(port = 4040, handler: Express = this.http, onRuntimeError?: (error: Error) => void): Promise<Server> {
        if (!this.ready) throw new ExecutionError("unavailable", "Application is not accepting listeners");
        const server = createServer(handler);
        const runtimeError = (cause: unknown) => {
            const error = cause instanceof Error ? cause : new Error(String(cause));
            this.listenerFailures.push(error);
            // Publish/enter shutdown before notifying user code, which may reenter close().
            void this.close().catch(() => {});
            if (onRuntimeError) {
                try { onRuntimeError(error); }
                catch (callbackError) { this.listenerFailures.push(new LifecycleError("HTTP runtime-error callback failed", [callbackError])); }
            }
        };
        this.servers.set(server, { runtimeError });
        try {
            await new Promise<void>((resolve, reject) => {
                const cleanup = () => {
                    server.off("error", error);
                    server.off("listening", listening);
                    server.off("close", closed);
                };
                const error = (cause: unknown) => { cleanup(); reject(cause); };
                const listening = () => {
                    cleanup();
                    // Core owns runtime failures. The optional callback only
                    // observes them and is installed before startup is visible.
                    server.on("error", runtimeError);
                    resolve();
                };
                const closed = () => error(new ExecutionError("unavailable", "HTTP listener closed during startup"));
                server.once("error", error);
                server.once("listening", listening);
                server.once("close", closed);
                try { server.listen(port); } catch (cause) { error(cause); }
            });
            if (!this.ready) {
                server.off("error", runtimeError);
                server.close();
                throw new ExecutionError("unavailable", "Application shut down while listening");
            }
            return server;
        } catch (error) {
            this.servers.delete(server);
            server.off("error", runtimeError);
            const errors: unknown[] = [error];
            try { await this.close(); } catch (cleanup) { errors.push(cleanup); }
            try { await this.closed; } catch (cleanup) { errors.push(cleanup); }
            if (errors.length > 1) throw new LifecycleError("Listener startup and cleanup failed", errors);
            throw error;
        }
    }
    close(): Promise<void> {
        if (this.shutdown) return this.shutdown;
        const bounded = deferredPromise<void>();
        const completed = deferredPromise<void>();
        // Publish both observers before any state transition or callback can reenter.
        this.shutdown = bounded.promise;
        this.completion = completed.promise;
        void this.shutdown.catch(() => {});
        void this.completion.catch(() => {});
        this.status = "draining";
        for (const wake of this.wakeLoops) wake();
        const stopped = Promise.allSettled([...this.servers].map(([server, owner]) => new Promise<void>((resolve, reject) => {
            server.close(error => {
                server.off("error", owner.runtimeError);
                this.servers.delete(server);
                error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve();
            });
            server.closeIdleConnections?.();
        })));
        const drained = this.active.size ? new Promise<void>(resolve => this.idle.add(resolve)) : Promise.resolve();
        const abort = setTimeout(() => {
            for (const execution of this.active) execution.abort(new ExecutionError("cancelled", "Application shutdown"));
        }, this.shutdownGrace);
        let boundedSettled = false;
        const timeout = setTimeout(() => {
            if (boundedSettled) return;
            boundedSettled = true;
            bounded.reject(new ShutdownTimeoutError());
        }, this.shutdownTimeout);
        const completionTask = (async () => {
            const errors: unknown[] = [];
            await drained;
            // Queue I/O/acknowledgement and in-flight claims own their resources too.
            await Promise.allSettled([...this.background]);
            clearTimeout(abort);
            this.idle.clear();
            // No application code is using resources now. Close leftover HTTP sockets.
            for (const server of this.servers.keys()) server.closeAllConnections?.();
            for (const result of await stopped) if (result.status === "rejected") errors.push(result.reason);
            const disposal = setupLifecycle(this.setup).dispose();
            void disposal.bounded.catch(error => {
                if (boundedSettled) return;
                boundedSettled = true;
                clearTimeout(timeout);
                bounded.reject(error);
            });
            try { await disposal.settled; } catch (error) { errors.push(error); }
            errors.push(...this.listenerFailures);
            this.status = "closed";
            if (errors.length) throw new LifecycleError("Application shutdown failed", errors);
        })();
        completionTask.then(completed.resolve, completed.reject);
        this.completion.then(
            () => {
                clearTimeout(timeout);
                if (!boundedSettled) { boundedSettled = true; bounded.resolve(); }
            },
            error => {
                clearTimeout(timeout);
                if (!boundedSettled) { boundedSettled = true; bounded.reject(error); }
            },
        );
        return this.shutdown;
    }
}

/** Public owner handle. Internal admission and completion are framework-only. */
export type Application<Services extends object = Record<string, unknown>> = Pick<ApplicationRuntime<Services>, "http" | "acceptEvent" | "tick" | "schedule" | "command" | "execute" | "runJob" | "work" | "listen" | "close" | "closed" | "state" | "ready" | "health" | "readiness" | "metrics">;
