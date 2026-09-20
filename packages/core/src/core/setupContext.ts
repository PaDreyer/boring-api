import { Logger } from "./logger";
import { LifecycleError } from "./lifecycle";
import { JobAdapter, JobBindings, JobDeclaration, JobOptions, JobRuntime } from "./jobs";

const owners = new WeakMap<object, { seal(): void; dispose(): Promise<void>; jobs: JobRuntime }>();

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
    private sealed = false;
    private disposal?: Promise<void>;

    constructor(readonly config: Config = {} as Config, declarations: ReadonlyMap<string, JobDeclaration> = new Map()) {
        super();
        this.set("logger", new Logger());
        owners.set(this, { seal: () => this.seal(), dispose: () => this.dispose(), jobs: new JobRuntime(declarations) });
    }
    /** Bind infrastructure during composition. Inject a named port into a facade, never return it from setup. */
    jobs(adapter: JobAdapter, options: JobOptions): JobBindings<Jobs> {
        if (this.sealed) throw new Error("Jobs can only be configured during setup");
        return setupLifecycle(this).jobs.bind<Jobs>(adapter, options);
    }
    /** Register immediately after acquisition, before any later fallible startup step. */
    onClose(name: string, dispose: () => void | Promise<void>): void {
        if (this.sealed) throw new Error("Resources can only be registered during setup");
        if (!name.trim() || typeof dispose !== "function") throw new TypeError("Cleanup requires a name and a function");
        this.cleanup.push({ name, dispose });
    }
    private seal(): void { this.sealed = true; Object.freeze(this.serviceValues); }
    private dispose(): Promise<void> {
        if (this.disposal) return this.disposal;
        this.seal();
        this.disposal = (async () => {
            const errors: unknown[] = [];
            for (const resource of this.cleanup.reverse()) {
                try { await resource.dispose(); }
                catch (error) { errors.push(new LifecycleError(`Cleanup failed: ${resource.name}`, [error])); }
            }
            if (errors.length) throw new LifecycleError("Resource cleanup failed", errors);
        })();
        return this.disposal;
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
    get logger(): Logger { return this.get("logger") as Logger; }
}
