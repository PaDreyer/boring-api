import { randomUUID } from "crypto";

/** Trusted identity established by authentication or the non-HTTP caller. */
export interface ExecutionIdentity {
    readonly kind: "user" | "machine";
    readonly id: string;
    readonly permissions: readonly string[];
}

declare const executionBrand: unique symbol;
const contexts = new WeakSet<object>();
/** Internal capability check for framework effects; shape-compatible objects are not trusted. */
export function assertExecution(context: ExecutionContext): void {
    if (!contexts.has(context)) throw new TypeError("Operation requires a framework-created execution context");
    context.throwIfAborted();
}
/** A framework-owned capability, never application data or a factory dependency. */
export interface ExecutionContext<Identity extends ExecutionIdentity | undefined = ExecutionIdentity | undefined> {
    readonly [executionBrand]: true;
    readonly identity: Identity;
    readonly tenantId: string | undefined;
    readonly correlationId: string;
    /** Absolute Unix time in milliseconds. */
    readonly deadline: number;
    readonly signal: AbortSignal;
    throwIfAborted(): void;
}

export interface ExecutionOptions<Identity extends ExecutionIdentity = ExecutionIdentity> {
    readonly identity: Identity;
    readonly tenantId?: string;
    readonly correlationId?: string;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
}

export class ExecutionError extends Error {
    constructor(public readonly code: "cancelled" | "deadline" | "ended" | "unavailable", message: string) {
        super(message);
        this.name = "ExecutionError";
    }
}

export function duration(value: number, name: string): number {
    if (!Number.isInteger(value) || value < 1 || value > 2147483647) throw new RangeError(`${name} must be an integer between 1 and 2147483647 milliseconds`);
    return value;
}

/** Snapshot plain data so caller mutation cannot change an active execution. */
export function snapshot<T>(value: T, seen = new Set<object>()): T {
    if (value === null || value === undefined || ["string", "number", "boolean"].includes(typeof value)) return value;
    if (typeof value !== "object" || seen.has(value)) throw new TypeError("Configuration and identity must be acyclic plain data");
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError("Configuration and identity must be plain data");
    if (Object.getOwnPropertySymbols(value).length) throw new TypeError("Data must not contain symbol keys");
    seen.add(value);
    const copy: any = Array.isArray(value) ? [] : {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
        if (!descriptor.enumerable) continue;
        if (!('value' in descriptor)) throw new TypeError("Data must not contain accessors");
        Object.defineProperty(copy, key, { value: snapshot(descriptor.value, seen), enumerable: true });
    }
    seen.delete(value);
    return Object.freeze(copy) as T;
}

function identifier(value: string, name: string): string {
    if (typeof value !== "string" || !value.trim() || value.length > 256) throw new TypeError(`${name} must be a non-empty string of at most 256 characters`);
    return value;
}

export function identitySnapshot<T extends ExecutionIdentity>(value: T): T {
    const result = snapshot(value);
    if (!result || !["user", "machine"].includes(result.kind)) throw new TypeError("Identity kind must be user or machine");
    identifier(result.id, "Identity id");
    if (!Array.isArray(result.permissions) || !result.permissions.every(permission => typeof permission === "string" && !!permission.trim())) throw new TypeError("Identity permissions must be an explicit string array");
    return result;
}

/** Internal owner. The public context has no identity setter, aborter or disposer. */
export class Execution {
    private readonly controller = new AbortController();
    private identity: ExecutionIdentity | undefined;
    private tenantId: string | undefined;
    private authenticated = false;
    private readonly timer: ReturnType<typeof setTimeout>;
    private readonly removeSignal: () => void;
    readonly context: ExecutionContext;

    constructor(timeoutMs: number, options: Partial<ExecutionOptions> = {}) {
        this.identity = options.identity === undefined ? undefined : identitySnapshot(options.identity);
        this.tenantId = options.tenantId === undefined ? undefined : identifier(options.tenantId, "Tenant id");
        const correlationId = identifier(options.correlationId ?? randomUUID(), "Correlation id");
        const deadline = Date.now() + Math.min(duration(options.timeoutMs ?? timeoutMs, "Execution timeout"), timeoutMs);
        const owner = this;
        this.context = Object.freeze({
            get identity() { return owner.identity; },
            get tenantId() { return owner.tenantId; },
            correlationId, deadline, signal: this.controller.signal,
            throwIfAborted() {
                if (!owner.controller.signal.aborted && Date.now() >= deadline) owner.abort(new ExecutionError("deadline", "Execution deadline exceeded"));
                if (owner.controller.signal.aborted) throw owner.controller.signal.reason;
            },
        }) as ExecutionContext;
        contexts.add(this.context);
        const cancel = () => this.abort(new ExecutionError("cancelled", "Execution cancelled"));
        options.signal?.addEventListener("abort", cancel, { once: true });
        this.removeSignal = () => options.signal?.removeEventListener("abort", cancel);
        if (options.signal?.aborted) cancel();
        this.timer = setTimeout(() => this.abort(new ExecutionError("deadline", "Execution deadline exceeded")), Math.max(1, deadline - Date.now()));
    }

    authenticate(identity: ExecutionIdentity | undefined, tenantId?: string): void {
        if (this.authenticated) throw new Error("Execution identity is already established");
        this.context.throwIfAborted();
        this.identity = identity === undefined ? undefined : identitySnapshot(identity);
        this.tenantId = tenantId === undefined ? undefined : identifier(tenantId, "Tenant id");
        this.authenticated = true;
    }
    abort(reason: ExecutionError): void { this.controller.abort(reason); }
    end(): void {
        clearTimeout(this.timer);
        this.removeSignal();
        this.abort(new ExecutionError("ended", "Execution has ended"));
    }
}
