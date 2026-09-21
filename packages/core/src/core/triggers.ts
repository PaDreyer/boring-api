import { createHash } from "crypto";
import { z, ZodTypeAny } from "zod";
import { duration, ExecutionContext, ExecutionIdentity, ExecutionOptions, identitySnapshot, snapshot } from "./execution";
import { JobAdapter, JobAttemptResult, JobContext, JobDeclaration, jobJson, JobOrigin, JobPolicy, JobRuntime, JsonValue, StoredJob, validateJobPolicy, WorkerOptions } from "./jobs";
import type { Application } from "./lifecycle";

export type DeliveryKind = "job" | "schedule" | "event";
export interface ScheduleTiming {
    /** UTC Unix milliseconds, inclusive first occurrence. No local-calendar/DST rules. */
    readonly startAt: number;
    readonly everyMs: number;
    readonly missed: "skip" | "latest" | "catch-up";
    readonly maxCatchUp: number;
    readonly overlap: "allow" | "skip";
}
export interface ScheduleOccurrence { readonly id: string; readonly scheduledAt: number; }
export interface EventMetadata { readonly id: string; readonly type: string; readonly version: number; }
export interface ScheduleContext<Payload, Services> extends JobContext<Payload, Services> { readonly occurrence: ScheduleOccurrence; }
export interface EventContext<Payload, Services> extends JobContext<Payload, Services> { readonly event: EventMetadata; }
export interface CommandContext<Input, Services> {
    readonly input: Input;
    readonly execution: ExecutionContext<ExecutionIdentity>;
    readonly services: Readonly<Services>;
}
export interface ScheduleDeclaration {
    readonly payload: ZodTypeAny;
    readonly input: JsonValue;
    readonly version: number;
    readonly timing: ScheduleTiming;
    readonly policy: JobPolicy;
    readonly handler: (context: ScheduleContext<any, any>) => void | Promise<void>;
}
export interface EventDeclaration {
    readonly payload: ZodTypeAny;
    readonly event: { readonly type: string; readonly version: number };
    /** Consumer revision, independent of the event contract's version. */
    readonly version: number;
    readonly policy: JobPolicy;
    readonly handler: (context: EventContext<any, any>) => void | Promise<void>;
}
export interface CommandDeclaration {
    readonly input: ZodTypeAny;
    readonly output: ZodTypeAny;
    readonly timeoutMs: number;
    readonly handler: (context: CommandContext<any, any>) => unknown;
}
export interface TriggerDeclarations {
    readonly schedules: ReadonlyMap<string, ScheduleDeclaration>;
    readonly events: ReadonlyMap<string, EventDeclaration>;
    readonly commands: ReadonlyMap<string, CommandDeclaration>;
}
export interface TriggerOptions { readonly identity: ExecutionIdentity; readonly tenantId?: string; }
export interface AcceptedEvent extends EventMetadata { readonly payload: JsonValue; readonly origin: JobOrigin; }
export interface EventReceipt { readonly id: string; readonly deliveries: readonly string[]; }
export interface ScheduleRegistration {
    readonly name: string;
    readonly version: number;
    readonly timing: ScheduleTiming;
    readonly input: JsonValue;
    readonly policy: JobPolicy;
    readonly origin: JobOrigin;
}
/** Atomic durable ingress; delivery uses the existing JobAdapter protocol. */
export interface TriggerAdapter extends JobAdapter {
    acceptEvent(event: AcceptedEvent, deliveries: readonly StoredJob[]): Promise<EventReceipt>;
    schedule(registration: ScheduleRegistration): Promise<readonly ScheduleOccurrence[]>;
}
export class TriggerError extends Error {
    constructor(readonly code: "unknown_event" | "incompatible_event" | "event_conflict" | "unknown_command" | "invalid_input" | "invalid_output" | "schedule_changed", message: string) { super(message); this.name = "TriggerError"; }
}
export function validateScheduleTiming(timing: ScheduleTiming): void {
    if (!timing || Object.keys(timing).sort().join(",") !== "everyMs,maxCatchUp,missed,overlap,startAt" ||
        !Number.isSafeInteger(timing.startAt) || timing.startAt < 0 || timing.startAt > 8640000000000000 ||
        !["skip", "latest", "catch-up"].includes(timing.missed) || !["allow", "skip"].includes(timing.overlap) ||
        !Number.isInteger(timing.maxCatchUp) || timing.maxCatchUp < 1 || timing.maxCatchUp > 100 ||
        timing.missed !== "catch-up" && timing.maxCatchUp !== 1) throw new TypeError("Schedules require UTC startAt, everyMs, missed, maxCatchUp (1–100; 1 outside catch-up), and overlap");
    duration(timing.everyMs, "Schedule interval");
}
/** Pure time rule. Catch-up keeps the newest bounded occurrences and consumes older ones. */
export function scheduleDue(timing: ScheduleTiming, previous: number | undefined, now: number): { due: number[]; cursor: number | undefined } {
    validateScheduleTiming(timing);
    if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("Schedule clock must be nonnegative Unix milliseconds");
    if (now < timing.startAt) return { due: [], cursor: previous };
    const latest = timing.startAt + Math.floor((now - timing.startAt) / timing.everyMs) * timing.everyMs;
    const first = previous === undefined ? timing.startAt : previous + timing.everyMs;
    if (latest < first) return { due: [], cursor: previous };
    if (timing.missed === "skip" && latest > first) return { due: [], cursor: latest };
    const start = timing.missed === "catch-up" ? Math.max(first, latest - (timing.maxCatchUp - 1) * timing.everyMs) : latest;
    const due: number[] = [];
    for (let at = start; at <= latest; at += timing.everyMs) due.push(at);
    return { due, cursor: latest };
}
/** Stable UUID for one logical delivery/occurrence; not a grant or a secret. */
export function triggerId(...parts: readonly (string | number)[]): string {
    const bytes = createHash("sha256").update(JSON.stringify(parts)).digest().subarray(0, 16);
    bytes[6] = (bytes[6] & 15) | 80; bytes[8] = (bytes[8] & 63) | 128;
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function validateTriggerDeclaration(kind: "schedule" | "event" | "command", name: string, value: any): void {
    const keys = kind === "schedule" ? ["payload", "input", "version", "timing", "policy", "handler"] : kind === "event" ? ["payload", "event", "version", "policy", "handler"] : ["input", "output", "timeoutMs", "handler"];
    if (!value || keys.some(key => !(key in value)) || Object.keys(value).some(key => !keys.includes(key)) || typeof value.handler !== "function") throw new TypeError(`${name}: ${kind} exports exactly ${keys.join(", ")}`);
    for (const key of kind === "command" ? ["input", "output"] : ["payload"]) if (typeof value[key]?.parseAsync !== "function") throw new TypeError(`${name}: ${key} must be a Zod schema`);
    if (kind === "command") { duration(value.timeoutMs, "Command timeout"); return; }
    validateJobPolicy(value.policy);
    if (!Number.isInteger(value.version) || value.version < 1 || value.version > 2147483647) throw new TypeError(`${name}: version must be a positive integer`);
    if (kind === "schedule") { validateScheduleTiming(value.timing); jobJson(value.input); }
    else if (!value.event || Object.keys(value.event).sort().join(",") !== "type,version" || !/^[a-z][a-z0-9./-]*$/.test(value.event.type) || typeof value.event.type !== "string" || !Number.isInteger(value.event.version) || value.event.version < 1 || value.event.version > 2147483647) throw new TypeError(`${name}: event requires literal type and positive version`);
}
const occurrenceSchema = z.object({ id: z.string().uuid(), scheduledAt: z.number().int().nonnegative() }).strict();
const eventSchema = z.object({ id: z.string().uuid(), type: z.string().min(1), version: z.number().int().positive() }).strict();
function configured(options: TriggerOptions): TriggerOptions {
    const identity = identitySnapshot(options.identity);
    if (identity.kind !== "machine") throw new TypeError("Triggers require an explicit configured machine identity");
    if (options.tenantId !== undefined && (typeof options.tenantId !== "string" || !options.tenantId.trim())) throw new TypeError("Invalid configured tenant");
    return Object.freeze({ identity, ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }) });
}
function origin(execution: ExecutionContext): JobOrigin {
    if (!execution.identity) throw new TypeError("Event ingress requires an authenticated execution");
    return { identity: { kind: execution.identity.kind, id: execution.identity.id }, correlationId: execution.correlationId, ...(execution.tenantId === undefined ? {} : { tenantId: execution.tenantId }) };
}
async function parsed(schema: ZodTypeAny, input: unknown, code: "invalid_input" | "invalid_output" = "invalid_input"): Promise<JsonValue> {
    try { return jobJson(await schema.parseAsync(jobJson(input))); }
    catch (error) { throw new TriggerError(code, error instanceof Error ? error.message : String(error)); }
}
/** Setup-owned. Persist only JSON snapshots; handlers/contexts live in the application. */
export class TriggerRuntime {
    private readonly queues = new Map<"schedule" | "event", { runtime: JobRuntime; adapter: TriggerAdapter; options: TriggerOptions }>();
    private commandOptions?: TriggerOptions;
    constructor(private readonly declarations: TriggerDeclarations) {}
    bind(kind: "schedule" | "event", adapter: TriggerAdapter, options: TriggerOptions): void {
        if (this.queues.has(kind)) throw new Error(`Configure ${kind}s only once`);
        if (typeof adapter.acceptEvent !== "function" || typeof adapter.schedule !== "function") throw new TypeError("Trigger adapter requires atomic event and schedule ingress");
        if (kind === "event" && options.tenantId !== undefined) throw new TypeError("Event tenant comes from trusted ingress, not the consumer binding");
        const config = configured(options);
        const entries = new Map<string, JobDeclaration>();
        for (const [name, declaration] of this.declarations[kind === "schedule" ? "schedules" : "events"]) {
            const metadata = kind === "schedule" ? occurrenceSchema : eventSchema.extend({ type: z.literal((declaration as EventDeclaration).event.type), version: z.literal((declaration as EventDeclaration).event.version) });
            entries.set(`@${kind}/${name}`, { payload: z.object({ data: declaration.payload, metadata }).strict(), version: declaration.version, policy: declaration.policy,
                handler: (ctx: JobContext<any, any>) => {
                    const context = { ...ctx, payload: ctx.payload.data };
                    return kind === "schedule" ? (declaration as ScheduleDeclaration).handler(Object.freeze({ ...context, occurrence: snapshot(ctx.payload.metadata) })) :
                        (declaration as EventDeclaration).handler(Object.freeze({ ...context, event: snapshot(ctx.payload.metadata) }));
                } });
        }
        const runtime = new JobRuntime(entries);
        // Claims remain in the shared queue implementation, scoped to this process kind.
        runtime.bind({ enqueue: job => adapter.enqueue(job), claim: lease => adapter.claim(lease, kind), renew: (claim, lease) => adapter.renew(claim, lease), succeed: claim => adapter.succeed(claim), fail: (claim, error, retry) => adapter.fail(claim, error, retry) }, { identity: config.identity });
        this.queues.set(kind, { runtime, adapter, options: config });
    }
    commands(options: TriggerOptions): void {
        if (this.commandOptions) throw new Error("Configure commands only once");
        this.commandOptions = configured(options);
    }
    attempt(application: Application<any>, kind: "schedule" | "event", options: WorkerOptions): Promise<JobAttemptResult | undefined> {
        const queue = this.queues.get(kind);
        if (!queue) throw new Error(`Configure ctx.${kind}s(adapter, { identity }) in setup`);
        return queue.runtime.attempt(application, options);
    }
    async accept(application: Application<any>, options: ExecutionOptions, event: EventMetadata & { readonly payload: unknown }): Promise<EventReceipt> {
        const queue = this.queues.get("event");
        if (!queue) throw new Error("Configure ctx.events in setup");
        return application.execute(options, async ({ execution }) => {
            const meta = eventSchema.parse({ id: event.id, type: event.type, version: event.version }); // Select metadata; payload cannot establish identity or tenant.
            meta.id = meta.id.toLowerCase();
            const matches = [...this.declarations.events].filter(([, declaration]) => declaration.event.type === meta.type && declaration.event.version === meta.version);
            if (!matches.length) throw new TriggerError([...this.declarations.events.values()].some(d => d.event.type === meta.type) ? "incompatible_event" : "unknown_event", `No consumer for ${meta.type} version ${meta.version}`);
            const wire = jobJson(event.payload);
            const provenance = origin(execution);
            const jobs: StoredJob[] = [];
            for (const [name, declaration] of matches) {
                await parsed(declaration.payload, wire);
                jobs.push({ id: triggerId("event", provenance.tenantId ?? "", meta.type, meta.id, name), name: `@event/${name}`, version: declaration.version,
                    payload: { data: wire, metadata: meta }, origin: provenance, policy: declaration.policy });
            }
            execution.throwIfAborted();
            return queue.adapter.acceptEvent({ ...meta, payload: wire, origin: provenance }, jobs);
        });
    }
    async tick(application: Application<any>): Promise<readonly ScheduleOccurrence[]> {
        const queue = this.queues.get("schedule");
        if (!queue) throw new Error("Configure ctx.schedules in setup");
        return application.execute(queue.options, async ({ execution }) => {
            const occurrences: ScheduleOccurrence[] = [];
            for (const [name, declaration] of this.declarations.schedules) {
                await parsed(declaration.payload, declaration.input);
                execution.throwIfAborted();
                occurrences.push(...await queue.adapter.schedule({ name, version: declaration.version, timing: declaration.timing, input: jobJson(declaration.input), policy: declaration.policy, origin: origin(execution) }));
            }
            return occurrences;
        });
    }
    async command(application: Application<any>, name: string, input: unknown, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<JsonValue> {
        const declaration = this.declarations.commands.get(name);
        if (!declaration) throw new TriggerError("unknown_command", `Unknown application command: ${name}`);
        if (!this.commandOptions) throw new Error("Configure ctx.commands({ identity }) in setup");
        return application.execute({ ...this.commandOptions, signal: options.signal, timeoutMs: Math.min(duration(options.timeoutMs ?? declaration.timeoutMs, "Command timeout"), declaration.timeoutMs) }, async ({ execution, services }) => {
            const value = await parsed(declaration.input, input);
            execution.throwIfAborted();
            const result = await declaration.handler(Object.freeze({ execution, services, input: value }));
            return parsed(declaration.output, result, "invalid_output");
        });
    }
}

/** Shared command transport error vocabulary; bootstrap owns output and signals. */
export function commandFailure(error: unknown): { exitCode: number; error: { code: string; message: string } } {
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "internal_error";
    const exitCode = ["invalid_input", "invalid_payload", "unknown_command"].includes(code) || error instanceof SyntaxError ? 2 : code === "forbidden" ? 3 : code === "deadline" ? 124 : code === "cancelled" ? 130 : 1;
    return { exitCode, error: { code: error instanceof SyntaxError ? "invalid_input" : code, message: error instanceof Error ? error.message : String(error) } };
}
