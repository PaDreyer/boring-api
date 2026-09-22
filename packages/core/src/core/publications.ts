import { z } from "zod";
import { assertExecution, ExecutionContext, ExecutionIdentity, identitySnapshot, snapshot } from "./execution";
import { JobAdapter, JobOrigin, JobPolicy, JobRuntime, StoredJob, WorkerOptions, JobAttemptResult, jobJson, validateJobPolicy } from "./jobs";
import type { ApplicationRuntime } from "./lifecycle";
import { EventMetadata, TriggerRuntime, triggerId } from "./triggers";

export const publicationName = "@publication/event" as const;
export interface PublishedEvent extends EventMetadata {
    readonly [key: string]: import("./jobs").JsonValue;
    readonly payload: import("./jobs").JsonValue;
}
export interface EventPublication extends StoredJob {
    readonly name: typeof publicationName;
    readonly version: 1;
    readonly payload: { readonly event: PublishedEvent };
}
export class PublicationError extends Error {
    constructor(readonly code: "invalid_publication" | "publication_conflict", message: string) {
        super(message); this.name = "PublicationError";
    }
}

const eventSchema = z.object({ id: z.string().uuid(), type: z.string().regex(/^[a-z][a-z0-9./-]*$/), version: z.number().int().positive(), payload: z.unknown() }).strict();
const publicationSchema = z.object({
    id: z.string().uuid(),
    name: z.literal(publicationName),
    version: z.literal(1),
    payload: z.object({ event: eventSchema }).strict(),
    origin: z.object({
        identity: z.object({ kind: z.enum(["user", "machine"]), id: z.string().min(1).max(256) }).strict(),
        tenantId: z.string().min(1).max(256).optional(),
        correlationId: z.string().min(1).max(256),
    }).strict(),
    policy: z.object({ maxAttempts: z.number().int(), retryDelayMs: z.number().int(), timeoutMs: z.number().int() }).strict(),
}).strict();
const declarationPolicy = { maxAttempts: 100, retryDelayMs: 1, timeoutMs: 2147483647 } as const;
const publications = new WeakSet<object>();

function publicationSnapshot(value: unknown): EventPublication {
    try {
        const parsed = publicationSchema.parse(jobJson(value));
        validateJobPolicy(parsed.policy);
        if (parsed.payload.event.id !== parsed.payload.event.id.toLowerCase()) {
            throw new PublicationError("invalid_publication", "Publication event IDs must use their lowercase UUID form");
        }
        const expected = triggerId("publication", parsed.origin.tenantId ?? "", parsed.payload.event.type, parsed.payload.event.id);
        if (parsed.id !== expected) throw new PublicationError("invalid_publication", "Publication ID does not match its tenant, event type and event ID");
        const intent = snapshot(parsed) as EventPublication;
        publications.add(intent);
        return intent;
    } catch (error) {
        if (error instanceof PublicationError) throw error;
        throw new PublicationError("invalid_publication", `Invalid event publication: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/** Revalidate a framework-created intent at an infrastructure boundary. Copies and fabricated values are not trusted. */
export function validateEventPublication(value: unknown): EventPublication {
    if (!value || typeof value !== "object" || !publications.has(value)) {
        throw new PublicationError("invalid_publication", "Expected a framework-created event publication intent");
    }
    return publicationSnapshot(value);
}

/** Build a durable intent from a live invocation without persisting grants or the context itself. */
export function eventPublication(execution: ExecutionContext, event: EventMetadata & { readonly payload: unknown }, policy: JobPolicy): EventPublication {
    assertExecution(execution);
    if (!execution.identity) throw new TypeError("Event publication requires an authenticated execution");
    validateJobPolicy(policy);
    const parsed = eventSchema.parse({ ...event, id: event.id.toLowerCase(), payload: jobJson(event.payload) });
    const origin: JobOrigin = { identity: { kind: execution.identity.kind, id: execution.identity.id }, correlationId: execution.correlationId,
        ...(execution.tenantId === undefined ? {} : { tenantId: execution.tenantId }) };
    return publicationSnapshot({ id: triggerId("publication", origin.tenantId ?? "", parsed.type, parsed.id), name: publicationName, version: 1,
        payload: { event: jobJson(parsed) as unknown as PublishedEvent }, origin, policy: { ...policy } });
}

/** Setup-owned publication delivery reusing the durable job claim/lease/fencing protocol. */
export class PublicationRuntime {
    private readonly runtime: JobRuntime;
    private bound = false;
    constructor(triggers: TriggerRuntime) {
        this.runtime = new JobRuntime(new Map([[publicationName, {
            payload: z.object({ event: eventSchema }).strict(), version: 1, policy: declarationPolicy,
            handler: async (ctx: any) => triggers.publish(ctx.execution, ctx.delivery.origin, ctx.payload.event),
        }]]));
    }
    bind(adapter: JobAdapter, options: { readonly identity: ExecutionIdentity }): void {
        if (this.bound) throw new Error("Configure publications only once");
        const identity = identitySnapshot(options.identity);
        if (identity.kind !== "machine") throw new TypeError("Publishers require an explicit configured machine identity");
        const lane: JobAdapter = {
            enqueue: job => adapter.enqueue(job),
            claim: lease => adapter.claim(lease, "publication"),
            renew: (claim, lease) => adapter.renew(claim, lease),
            succeed: claim => adapter.succeed(claim),
            fail: (claim, error, retry) => adapter.fail(claim, error, retry),
        };
        this.runtime.bind(lane, { identity });
        this.bound = true;
    }
    attempt(application: ApplicationRuntime<any>, options: WorkerOptions): Promise<JobAttemptResult | undefined> {
        if (!this.bound) throw new Error("Configure ctx.publications(adapter, { identity }) in setup");
        return this.runtime.attempt(application, options, "publisher");
    }
}
