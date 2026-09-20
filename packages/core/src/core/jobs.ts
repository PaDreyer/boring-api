import { randomUUID } from "crypto";
import type { ZodTypeAny } from "zod";
import { ApplicationError } from "./errors";
import { assertExecution, duration, ExecutionContext, ExecutionIdentity, identitySnapshot, snapshot } from "./execution";
import type { Application } from "./lifecycle";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface JobPolicy { readonly maxAttempts: number; readonly retryDelayMs: number; readonly timeoutMs: number; }
export interface JobReceipt { readonly id: string; }
export interface JobOrigin {
    readonly identity: { readonly kind: "user" | "machine"; readonly id: string };
    readonly tenantId?: string;
    readonly correlationId: string;
}
export interface JobDelivery {
    readonly id: string;
    readonly name: string;
    readonly attempt: number;
    readonly attemptId: string;
    readonly origin: JobOrigin;
}
export interface JobContext<Payload, Services> {
    readonly payload: Payload;
    readonly services: Readonly<Services>;
    readonly execution: ExecutionContext<ExecutionIdentity>;
    readonly delivery: JobDelivery;
}
export interface JobDeclaration {
    readonly payload: ZodTypeAny;
    readonly version: number;
    readonly policy: JobPolicy;
    readonly handler: (context: JobContext<any, any>) => unknown;
}
export interface StoredJob {
    readonly id: string;
    readonly name: string;
    readonly version: number;
    readonly payload: JsonValue;
    readonly origin: JobOrigin;
    readonly policy: JobPolicy;
}
export interface JobClaim extends StoredJob { readonly attempt: number; readonly token: string; }
export interface JobFailure { readonly code: string; readonly message: string; }
/** Each method is awaited. Fenced writes return false once a lease has expired or changed. */
export interface JobAdapter {
    enqueue(job: StoredJob): Promise<void>;
    claim(leaseMs: number): Promise<JobClaim | undefined>;
    renew(claim: JobClaim, leaseMs: number): Promise<boolean>;
    succeed(claim: JobClaim): Promise<boolean>;
    fail(claim: JobClaim, error: JobFailure, retryInMs?: number): Promise<boolean>;
}
export interface JobPort<Input> { enqueue(execution: ExecutionContext, payload: Input): Promise<JobReceipt>; }
export interface JobBindings<Inputs> { for<Name extends keyof Inputs & string>(name: Name): JobPort<Inputs[Name]>; }
export interface JobOptions { readonly identity: ExecutionIdentity; }
export interface WorkerOptions { readonly leaseMs?: number; readonly pollIntervalMs?: number; }
export type JobAttemptResult = { readonly id: string; readonly status: "succeeded" | "retry" | "failed" | "lost" };

export class JobError extends Error {
    constructor(readonly code: "unknown_job" | "incompatible_version" | "invalid_payload" | "invalid_metadata" | "lease_lost", message: string) {
        super(message); this.name = "JobError";
    }
}

/** Reject JSON's silent omissions/coercions instead of losing data on persistence. */
export function jobJson(value: unknown): JsonValue {
    const seen = new Set<object>();
    function visit(item: unknown): JsonValue {
        if (item === null || typeof item === "string" || typeof item === "boolean") return item;
        if (typeof item === "number" && Number.isFinite(item)) return item;
        if (!item || typeof item !== "object" || seen.has(item) ||
            !Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null ||
            Object.getOwnPropertySymbols(item).length) throw new JobError("invalid_payload", "Job data must be finite, acyclic JSON data");
        seen.add(item);
        const result: any = Array.isArray(item) ? [] : {};
        const descriptors = Object.getOwnPropertyDescriptors(item);
        if (Array.isArray(item) && (Object.keys(item).length !== item.length || Object.keys(item).some((key, index) => key !== String(index)))) {
            throw new JobError("invalid_payload", "Job arrays must be dense and contain no extra properties");
        }
        for (const [key, descriptor] of Object.entries(descriptors)) {
            if (Array.isArray(item) && key === "length") continue;
            if (!descriptor.enumerable || !("value" in descriptor)) throw new JobError("invalid_payload", "Job data must contain only enumerable data properties");
            Object.defineProperty(result, key, { value: visit(descriptor.value), enumerable: true, writable: true, configurable: true });
        }
        seen.delete(item);
        return result;
    }
    return visit(value);
}

export function validateJobPolicy(policy: JobPolicy): void {
    if (!policy || !Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1 || policy.maxAttempts > 100) throw new TypeError("Job maxAttempts must be between 1 and 100");
    duration(policy.retryDelayMs, "Job retry delay");
    duration(policy.timeoutMs, "Job timeout");
}
export function validateJobDeclaration(name: string, value: JobDeclaration): void {
    if (!value || Object.keys(value).some(key => !["payload", "version", "policy", "handler"].includes(key)) ||
        typeof value.handler !== "function" || typeof value.payload?.parseAsync !== "function" ||
        !Number.isInteger(value.version) || value.version < 1 || value.version > 2147483647) throw new TypeError(`${name}: export only payload (Zod), positive version, policy and handler`);
    validateJobPolicy(value.policy);
}

function failureMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    let length = 0;
    // Bound diagnostics without turning a valid Unicode pair into a lone surrogate.
    for (const character of message) {
        if (length + character.length > 2000) break;
        length += character.length;
    }
    return message.slice(0, length);
}

/** Owned by setup/application, never exposed through services. */
export class JobRuntime {
    private adapter?: JobAdapter;
    private identity?: ExecutionIdentity;
    constructor(private readonly declarations: ReadonlyMap<string, JobDeclaration>) {}
    bind<Inputs>(adapter: JobAdapter, options: JobOptions): JobBindings<Inputs> {
        if (this.adapter) throw new Error("Configure the job adapter only once per application");
        for (const name of ["enqueue", "claim", "renew", "succeed", "fail"] as const) if (typeof adapter?.[name] !== "function") throw new TypeError(`Job adapter requires ${name}`);
        this.identity = identitySnapshot(options.identity);
        if (this.identity.kind !== "machine") throw new TypeError("Workers require an explicit configured machine identity");
        this.adapter = adapter;
        return Object.freeze({ for: <Name extends keyof Inputs & string>(name: Name): JobPort<Inputs[Name]> => {
            const declaration = this.declarations.get(name);
            if (!declaration) throw new JobError("unknown_job", `Unknown job: ${name}`);
            return Object.freeze({ enqueue: async (execution: ExecutionContext, payload: Inputs[Name]) => {
                assertExecution(execution);
                if (!execution.identity) throw new TypeError("Enqueue requires an authenticated execution");
                const wire = jobJson(payload);
                // Persist original schema input: transforms must run once, at each validation boundary.
                try { jobJson(await declaration.payload.parseAsync(jobJson(wire))); }
                catch (error) { throw new JobError("invalid_payload", `Invalid payload for ${name}: ${error instanceof Error ? error.message : String(error)}`); }
                execution.throwIfAborted();
                const id = randomUUID();
                const origin: JobOrigin = { identity: { kind: execution.identity.kind, id: execution.identity.id },
                    correlationId: execution.correlationId, ...(execution.tenantId === undefined ? {} : { tenantId: execution.tenantId }) };
                await adapter.enqueue({ id, name, version: declaration.version, payload: wire, origin, policy: declaration.policy });
                return Object.freeze({ id });
            } });
        } });
    }
    async attempt(application: Application<any>, options: WorkerOptions): Promise<JobAttemptResult | undefined> {
        if (!this.adapter || !this.identity) throw new Error("Configure jobs with ctx.jobs(adapter, { identity }) in setup");
        const adapter = this.adapter;
        const leaseMs = duration(options.leaseMs ?? 30000, "Job lease");
        if (leaseMs < 30) throw new RangeError("Job lease must be at least 30 milliseconds");
        const claim = await adapter.claim(leaseMs);
        if (!claim) return undefined;
        const cancel = new AbortController();
        let lost = false;
        let renewalFailed = false;
        let renewalError: unknown;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let renewal: Promise<void> = Promise.resolve();
        const lose = () => { lost = true; cancel.abort(new JobError("lease_lost", "Job lease lost")); };
        let finished = false;
        const heartbeat = () => {
            timer = setTimeout(() => {
                renewal = (async () => {
                    try { if (!await adapter.renew(claim, leaseMs)) lose(); }
                    catch (error) { renewalFailed = true; renewalError = error; lose(); }
                    if (!finished && !lost) heartbeat();
                })();
            }, Math.max(1, Math.floor(leaseMs / 3)));
        };
        heartbeat();
        try {
            let failure: JobFailure | undefined;
            let retry: number | undefined;
            try {
                const declaration = this.declarations.get(claim.name);
                if (!declaration) throw new JobError("unknown_job", `Unknown stored job: ${claim.name}`);
                if (claim.version !== declaration.version) throw new JobError("incompatible_version", `Stored version ${claim.version} differs from ${declaration.version}`);
                validateJobPolicy(claim.policy);
                const origin = snapshot(jobJson(claim.origin)) as unknown as JobOrigin;
                if (!origin.identity || !["user", "machine"].includes(origin.identity.kind) || typeof origin.identity.id !== "string" ||
                    !origin.identity.id || typeof origin.correlationId !== "string" || !origin.correlationId ||
                    origin.tenantId !== undefined && (typeof origin.tenantId !== "string" || !origin.tenantId)) throw new JobError("invalid_metadata", "Invalid stored origin");
                // Each delivery uses current configured grants, never permissions from the payload or origin.
                await application.execute({ identity: this.identity, tenantId: origin.tenantId,
                    correlationId: randomUUID(), signal: cancel.signal, timeoutMs: Math.min(claim.policy.timeoutMs, declaration.policy.timeoutMs) }, async ({ execution, services }) => {
                    let payload: unknown;
                    try { payload = jobJson(await declaration.payload.parseAsync(jobJson(claim.payload))); }
                    catch (error) { throw new JobError("invalid_payload", `Stored payload no longer validates: ${error instanceof Error ? error.message : String(error)}`); }
                    execution.throwIfAborted();
                    await declaration.handler(Object.freeze({ execution, services, payload,
                        delivery: snapshot({ id: claim.id, name: claim.name, attempt: claim.attempt, attemptId: execution.correlationId, origin }) }));
                });
            } catch (error) {
                failure = { code: error instanceof JobError || error instanceof ApplicationError ? error.code : "attempt_failed",
                    message: failureMessage(error) };
                const permanent = error instanceof JobError || error instanceof ApplicationError;
                if (!permanent && claim.attempt < claim.policy.maxAttempts) retry = Math.min(3600000, claim.policy.retryDelayMs * 2 ** (claim.attempt - 1));
            }
            if (lost) return { id: claim.id, status: "lost" };
            const accepted = failure ? await adapter.fail(claim, failure, retry) : await adapter.succeed(claim);
            return { id: claim.id, status: !accepted ? "lost" : failure ? retry === undefined ? "failed" : "retry" : "succeeded" };
        } finally {
            finished = true;
            if (timer) clearTimeout(timer);
            await renewal;
            // Infrastructure failures stop the worker after actual operation settlement.
            if (renewalFailed) throw renewalError;
        }
    }
}
