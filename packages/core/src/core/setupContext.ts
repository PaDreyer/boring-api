import { Logger } from "./logger";
import { LifecycleError } from "./lifecycle";
import { JobAdapter, JobBindings, JobDeclaration, JobOptions, JobRuntime } from "./jobs";
import { TriggerAdapter, TriggerDeclarations, TriggerOptions, TriggerRuntime } from "./triggers";
import { OperationsRuntime, OperationalAdapter, OperationalFlushError, OperationalOptions, ReadinessProbeOptions } from "./operations";
import { PublicationRuntime } from "./publications";

interface SetupDisposal { readonly bounded: Promise<void>; readonly settled: Promise<void>; }
const owners = new WeakMap<object, { seal(): void; dispose(): SetupDisposal; jobs: JobRuntime; triggers: TriggerRuntime; publications: PublicationRuntime; operations: OperationsRuntime }>();

/** Internal ownership API, intentionally absent from Core public exports. */
export function setupLifecycle(context: object) {
    const owner = owners.get(context);
    if (!owner) throw new Error("Unknown setup owner");
    return owner;
}

/** Shared dependencies; execution state never belongs here. */
export class SetupContext<Config = Readonly<Record<string, never>>, Jobs = Record<string, never>> extends Map<string, unknown> {
    private readonly serviceValues: Record<string, unknown> = {};
    private readonly cleanup: { name: string; dispose: () => void | Promise<void> }[] = [];
    private readonly frameworkLogger: Logger;
    private sealed = false;
    private disposal?: SetupDisposal;

    constructor(readonly config: Config = {} as Config, declarations: ReadonlyMap<string, JobDeclaration> = new Map(), triggers: TriggerDeclarations = { schedules: new Map(), events: new Map(), commands: new Map() }) {
        super();
        const operations = new OperationsRuntime();
        const triggerRuntime = new TriggerRuntime(triggers);
        this.frameworkLogger = new Logger(operations);
        owners.set(this, { seal: () => this.seal(), dispose: () => this.dispose(), jobs: new JobRuntime(declarations), triggers: triggerRuntime,
            publications: new PublicationRuntime(triggerRuntime), operations });
    }
    /** Bind infrastructure during composition. Inject a named port into a facade, never return it from setup. */
    jobs(adapter: JobAdapter, options: JobOptions): JobBindings<Jobs> {
        if (this.sealed) throw new Error("Jobs can only be configured during setup");
        return setupLifecycle(this).jobs.bind<Jobs>(adapter, options);
    }
    schedules(adapter: TriggerAdapter, options: TriggerOptions): void {
        if (this.sealed) throw new Error("Schedules can only be configured during setup");
        setupLifecycle(this).triggers.bind("schedule", adapter, options);
    }
    events(adapter: TriggerAdapter, options: Pick<TriggerOptions, "identity">): void {
        if (this.sealed) throw new Error("Events can only be configured during setup");
        setupLifecycle(this).triggers.bind("event", adapter, options);
    }
    commands(options: TriggerOptions): void {
        if (this.sealed) throw new Error("Commands can only be configured during setup");
        setupLifecycle(this).triggers.commands(options);
    }
    /** Bind the durable publication lane. Business transactions stage intents through their own typed ports. */
    publications(adapter: JobAdapter, options: JobOptions): void {
        if (this.sealed) throw new Error("Publications can only be configured during setup");
        setupLifecycle(this).publications.bind(adapter, options);
    }
    /** Register one non-blocking log/trace/metric sink. Resource ownership still uses onClose. */
    observability(adapter: OperationalAdapter, options: OperationalOptions = {}): void {
        if (this.sealed) throw new Error("Observability can only be configured during setup");
        setupLifecycle(this).operations.bind(adapter, options);
    }
    /** Register a required-infrastructure probe used by application.readiness(). */
    readiness(name: string, check: () => void | Promise<void>, options: ReadinessProbeOptions = {}): void {
        if (this.sealed) throw new Error("Readiness can only be configured during setup");
        setupLifecycle(this).operations.readiness(name, check, options);
    }
    /** Register immediately after acquisition, before any later fallible startup step. */
    onClose(name: string, dispose: () => void | Promise<void>): void {
        if (this.sealed) throw new Error("Resources can only be registered during setup");
        if (!name.trim() || typeof dispose !== "function") throw new TypeError("Cleanup requires a name and a function");
        this.cleanup.push({ name, dispose });
    }
    private seal(): void { this.sealed = true; Object.freeze(this.serviceValues); }
    private dispose(): SetupDisposal {
        if (this.disposal) return this.disposal;
        this.seal();
        const flush = setupLifecycle(this).operations.flush();
        const settled = (async () => {
            const errors: unknown[] = [];
            try { await flush.settled; }
            catch (error) {
                const causes = error instanceof OperationalFlushError ? error.errors : [error];
                errors.push(new LifecycleError("Operational flush failed", causes));
            }
            for (const resource of this.cleanup.reverse()) {
                try { await resource.dispose(); }
                catch (error) { errors.push(new LifecycleError(`Cleanup failed: ${resource.name}`, [error])); }
            }
            if (errors.length) throw new LifecycleError("Resource cleanup failed", errors);
        })();
        void settled.catch(() => {});
        return this.disposal = Object.freeze({ bounded: flush.bounded, settled });
    }
    set(key: string, value: unknown): this {
        if (this.sealed) throw new Error("Setup is complete");
        this.serviceValues[key] = value;
        return super.set(key, value);
    }
    delete(key: string): boolean {
        if (this.sealed) throw new Error("Setup is complete");
        delete this.serviceValues[key];
        return super.delete(key);
    }
    clear(): void {
        if (this.sealed) throw new Error("Setup is complete");
        for (const key of Object.keys(this.serviceValues)) delete this.serviceValues[key];
        super.clear();
    }
    assign(values: unknown): void {
        if (!values || typeof values !== "object" || Array.isArray(values)) return;
        for (const [key, value] of Object.entries(values as Record<string, unknown>)) this.set(key, value);
    }
    get services(): Readonly<Record<string, unknown>> { return this.serviceValues; }
    get logger(): Logger { return this.frameworkLogger; }
}
