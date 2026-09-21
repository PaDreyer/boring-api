# Schedules, events and application commands

[Roles](architecture.md) · [Lifecycle](lifecycle.md) · [Jobs](jobs.md)

Every entry validates data and calls an injected facade. The facade still owns
business access, transactions and idempotency. There is no callback registry,
second execution context or business implementation in the CLI.

## Declarations and composition

Sibling `schedules/<name>/schedule.ts`, `events/<name>/event.ts` and
`commands/<name>/command.ts` use lowercase slash-separated names, one declaration
per folder, with no helper files or barrels. Compiled declarations use `.js`.
Import public schemas, generated `./$types`, Zod and Core types. Runtime Core
imports are limited to named errors and `requirePermissions`. Facades, services,
adapters, SDKs, application construction and additional execution admission are
forbidden here. Reflective mutation, indirect imports, retained contexts and
capability erasure obey the same mandatory checks as jobs (`BORING101`–`BORING117`).

| Entry | Exact exports | Generated context |
| --- | --- | --- |
| Schedule | `payload` Zod schema, JSON `input`, positive `version`, `timing`, job `policy`, `handler` | `ScheduleHandler`, `ScheduleContext`: payload, execution, services, delivery, occurrence |
| Event consumer | `payload` Zod schema, `event: {type, version}`, positive consumer `version`, job `policy`, `handler` | `EventHandler`, `EventContext`: payload, execution, services, delivery, event |
| Command | `input` and `output` Zod schemas, positive `timeoutMs`, `handler` | `CommandHandler`, `CommandContext`: input, execution, services |

Versions, policy, timing, event metadata and schedule input are statically readable
constants. Schedule input is checked against the schema's TypeScript input type;
Zod refinements/transforms run at execution boundaries. JSON restrictions from
[jobs](jobs.md) apply to both input and parsed output. Schedules/events discard
handler results; commands validate and serialize their output.

Setup uses the same application-owned PostgreSQL pool and optional adapter:

```ts
const database = createDatabase({ connectionString: ctx.config.databaseUrl });
ctx.onClose("PostgreSQL", () => database.close());
ctx.schedules(database.jobs, {
    identity: { kind: "machine", id: "scheduler-worker", permissions: ctx.config.schedulePermissions },
});
ctx.events(database.jobs, {
    identity: { kind: "machine", id: "event-worker", permissions: ctx.config.eventPermissions },
});
ctx.commands({
    identity: { kind: "machine", id: "command", permissions: ctx.config.commandPermissions },
});
```

`ctx.jobs` remains independent. Each binding is optional, setup-only and configured
once. New applications with only commands need no queue. `TriggerAdapter` extends
`JobAdapter` with atomic `acceptEvent` and `schedule` handoffs. The existing optional
`@boringapi/jobs-postgres` implements both; there is no additional runtime package.
Append its **`triggerMigration` after `jobMigration`** to the application's explicit
migration list. Never run migrations implicitly on startup.

## Schedule time and delivery

```ts
import { createOrder } from "$modules/orders/schemas";
import type { ScheduleHandler } from "./$types";
export const payload = createOrder.omit({ requestId: true });
export const input = { item: "Scheduled order", quantity: 1 };
export const version = 1;
export const timing = {
    startAt: 0, everyMs: 3600000, missed: "latest", maxCatchUp: 1, overlap: "skip",
} as const;
export const policy = { maxAttempts: 5, retryDelayMs: 1000, timeoutMs: 30000 } as const;
export const handler: ScheduleHandler = async ctx => {
    await ctx.services.orders.create(ctx.execution, { ...ctx.payload, requestId: ctx.occurrence.id });
};
```

Time is a UTC Unix-millisecond interval grid `startAt + n × everyMs`, inclusive of
`startAt`. `startAt` is a nonnegative safe integer within JavaScript's Date range;
`everyMs` is 1–2,147,483,647. There are no cron expressions, local calendar times,
IANA timezone conversion or DST ambiguities. PostgreSQL's clock, read **after the
cursor row lock**, determines due work. Polling can delay admission. Clock movement
backwards never rewinds a cursor. Correct host/database clocks remain operational
requirements; there is no punctuality guarantee.

The persisted cursor is per schedule name. On first deployment its history begins
at the declared `startAt`, so the same missed-run policy applies to initial backlog
and downtime. All eligible occurrences through the latest due time are consumed:

| `missed` | Admission |
| --- | --- |
| `latest` | Only the newest due occurrence. `maxCatchUp` must be 1. |
| `skip` | Admit if precisely one occurrence is due since the cursor; otherwise consume all overdue occurrences without admitting any. `maxCatchUp` must be 1. |
| `catch-up` | Admit the newest at most `maxCatchUp` occurrences (1–100); discard older overdue occurrences. No unbounded backlog. |

`overlap: "allow"` admits the selected occurrences independently. `overlap: "skip"`
skips all selected occurrences while any work for the same schedule name is pending
or running (including retries and older revisions); otherwise it admits only the
newest selected occurrence. Skipped occurrences advance the cursor. Retained failed
or successful work does not block later occurrences. Expired claims are recovered
or exhausted by workers, not by the scheduler.

Cursor locking, queue INSERTs and cursor advancement share one durable transaction.
Concurrent schedulers cooperate; failed handoff rolls back the cursor. A crash
before commit leaves work eligible, while a lost commit response is resolved by the
persisted cursor on retry. `occurrence.id` is a deterministic UUID from name,
revision and due time; `scheduledAt` is the due time. Retries retain that occurrence
ID; `delivery.attemptId` and execution correlation change on every attempt.

Changes to timing, input, policy or configured schedule machine ID/tenant require a
strictly increased `version`. A same-version change and a stale scheduler revision
fail explicitly; rolling deployments must stop obsolete schedulers. A new revision
applies its declared start and missed policy with a fresh cursor. Existing queued
work retains its version and policy; incompatible revisions become retained failures
when claimed. Removing a declaration stops new scheduling after old scheduler
processes are stopped. Already queued removed work becomes an unknown-declaration
failure. Drain or migrate explicitly when old work must complete.

Overlap suppression concerns queue state, **not exclusive business effects**.
Lease loss or an explicitly retried failure can overlap an old non-cooperative
operation. Preserve application idempotency; never treat lease fencing as a lock on
external side effects. Retain cursor records: deleting/rewinding them is unsupported
and can encounter existing occurrence IDs. There is no automatic retention pruning.

## Durable event ingress and consumers

```ts
import { queuedOrder } from "$modules/orders/schemas";
import type { EventHandler } from "./$types";
export const payload = queuedOrder;
export const event = { type: "orders.create-requested", version: 1 } as const;
export const version = 1; // consumer revision
export const policy = { maxAttempts: 5, retryDelayMs: 1000, timeoutMs: 30000 } as const;
export const handler: EventHandler = async ctx => {
    await ctx.services.orders.create(ctx.execution, ctx.payload);
};
```

A trusted bootstrap/transport adapter calls:

```ts
await application.acceptEvent(
    { identity: trustedProducer, tenantId: trustedTenant, correlationId: originCorrelation },
    { id: eventUuid, type: "orders.create-requested", version: 1, payload },
);
```

This is an explicit controlled ingress capability, not an automatically installed
public endpoint. Authenticate/authorize the producer and tenant before invoking it.
Application entry roles cannot admit more executions. Producer grants authorize no
consumer actions: each attempt uses its configured machine identity and grants.
Tenant is derived from trusted ingress options, never payload fields. Persisted
origin contains kind/id, tenant and correlation only. Consumer correlation is fresh.
Schedule and command tenants, when used, come from their setup binding.

Event types match `[a-z][a-z0-9./-]*`, versions are positive integers and event IDs
are UUIDs, normalized to lowercase. Matching consumers are discovered by type and
version; all their payload schemas must validate before persistence. Unknown types,
unsupported versions and invalid payloads reject ingress, without a durable receipt
or partial fanout. Stored deliveries are validated again, including event metadata.
Removed consumers, incompatible revisions and invalid stored data become failures.

Acceptance means the event record and **all** matched consumer deliveries committed
in one PostgreSQL transaction with synchronous commit enabled. It does not mean
processing completed. Event identity is `(trusted tenant, type, UUID)`; each consumer
has a distinct deterministic delivery ID. Duplicate acceptance returns the original
fanout, including completed/failed deliveries, without adding consumers introduced
later. Same ID with different version, JSON content or producer identity conflicts.
The first correlation remains provenance. Duplicate submissions still undergo the
current discovery/schema admission checks before consulting the receipt.

The separate consumer process uses the existing claim/heartbeat/fenced-ack protocol.
There is **no ordering guarantee**, including within one event type. Each consumer
retries independently: bounded at-least-once delivery, exponential delay up to one
hour, permanent business/schema/version errors, and retained exhausted failures.
`get`, `failed` and explicit `retry` inspect/replay the same queue records. A lost
confirmation after business commit can repeat the handler. The reference's UUID
`requestId` deduplicates order, audit and idempotency writes in the facade-owned
transaction, even across distinct event IDs or a process restart. Event IDs and
queue receipts alone do not make business effects idempotent.

Business commit plus publication/ingress is **not atomic**. This milestone provides
atomic receipt-plus-fanout, not a universal transactional outbox. Reliable publication
coupled to arbitrary business commits remains milestone 5.

## Commands and process operation

Commands are named schema-validated invocations; `executions/` remains the explicit
programmatic adapter for an already trusted caller using `application.execute`.
Framework commands such as check/build manipulate source; application commands call
business facades. There is no permissions CLI flag and no automatic retry.

```ts
import { queuedOrder, order } from "$modules/orders/schemas";
import type { CommandHandler } from "./$types";
export const input = queuedOrder;
export const output = order;
export const timeoutMs = 30000;
export const handler: CommandHandler = ctx => ctx.services.orders.create(ctx.execution, ctx.input);
```

`application.command(name, input, { signal?, timeoutMs? })` uses setup's configured
machine and optional tenant. The caller can shorten the declared/application deadline,
not extend it. A successful call returns parsed JSON data. A manual retry is another
invocation; reuse `requestId` for the same order intent and choose a new one for a
new intent. Cancellation after a successful business commit cannot undo that commit.

| Process | Development | Compiled production (Node only) |
| --- | --- | --- |
| Scheduler ingress | `boring dev --scheduler` | `node dist/boring-scheduler.cjs` |
| Schedule deliveries | `boring dev --schedule-worker` | `node dist/boring-schedule-worker.cjs` |
| Event consumers | `boring dev --consumer` | `node dist/boring-consumer.cjs` |
| Command, once | `boring command orders/create --source --input '<JSON>'` | `node dist/boring-command.cjs orders/create '<JSON>'` |

`boring scheduler`, `boring schedule-worker`, `boring consumer` and `boring command`
also select an existing build with `--out-dir`/`--project`; these are development
conveniences. Production needs neither CLI, TypeScript nor ts-node. All generated
process filenames are reserved build output. No trigger opens an HTTP listener.
Commands run once; source watching never silently replays them. Source workers watch
all convention roots, validate, regenerate types and drain before restart.

Command stdout contains the JSON result only after successful cleanup; errors go to stderr as
`{"error":{"code":"...","message":"..."}}`. Application logs should use stderr
so they do not contaminate stdout. Exit statuses: 0 success, 2 unknown command or
invalid JSON/input, 3 forbidden, 124 deadline, 130 cancellation/signal, 1 other or
cleanup failure. Unknown commands/invalid schemas do not invoke facades. Timeout and
cancellation are cooperative; output validation also belongs to the execution.
Signals remain observed during cleanup: source and compiled CLI commands suppress
success output and exit 130 when cancellation arrives there. Cleanup failure takes
precedence and exits 1.

`application.tick()` admits due schedules once. `application.schedule()` polls;
`runJob({kind:"event"|"schedule"})` executes one attempt and
`work({kind:"event"|"schedule"})` polls sequentially. Normal jobs retain the default
kind. PostgreSQL claims are partitioned by the reserved `@event/`/`@schedule/` names.
Run independent processes to scale. Infrastructure I/O errors stop loops so the
supervisor can restart them; retained business failures do not stop the loop.

All process types use the existing owner. Close stops admission and wakes polling,
drains active executions and awaited ingress/claims/heartbeat/ack I/O, then disposes
resources. After grace, operations receive cancellation. A shutdown timeout rejects
the caller's wait but does not free resources under outstanding work; `closed`
observes eventual disposal. Bootstrap owns signals and final forced-kill policy.
Core installs no global signal handler. Durable commit may succeed even when the
caller later receives cancellation: repeat the same event/business ID to reconcile.
CLI and development workers install signal handling before asynchronous setup;
an early signal waits for setup and resource disposal and prevents worker admission.

## Tooling, migration and release

Inspection **v5** adds `triggers` with kind/name, schemas, literal timing/event/input,
policy, timeout, source and resolved facade calls. All tools share convention roots;
checks/inspection/generation never execute application modules. `BORING117` covers
new declaration contracts; existing boundary diagnostics retain their codes.
`BORING113` protects operation objects even through helper parameters and nested
assignment patterns. `BORING115` rejects retaining contexts, extracted execution
signals/methods and capturing or bound callbacks beyond their invocation, including
destructuring assignments, default/rest/spread parameter bindings and array methods
returning the existing callbacks. Copying data such as `signal.aborted` remains valid;
copying a callback array does not give its elements a longer lifetime.
Local overloads and mutable callable bindings are checked through their possible
implementations, including native `call`/`apply` forwarding. Array aliases from
`reverse`/`sort`/`copyWithin`/`fill` preserve the original storage identity, including
subsequent writes through either alias. Reordering existing elements invalidates
precise index selection conservatively. Copying methods retain separate outer
storage; their nested arrays and objects remain shared with the original.
Callable array elements participate in the same analysis as direct local calls.
Native `map`/`flatMap`/`Array.from` callbacks retain their argument and result
provenance, including callbacks produced by mapping and nested storage returned
by a mapper. Indirect native `call`/`apply`/`bind` invocations, including constant
local argument tuples passed to `apply`, and callback
`thisArg` follow the same provenance. Local callbacks passed through native array
operations keep the arguments bound to their implementation. Array iteration and
reduction callbacks use the same local flow;
copying data or invoking a callback entirely within the execution remains valid.
For native array calls, dynamic argument lists passed to `apply`, spread callback
arguments and alias/`bind` chains beyond the analysis depth are unsupported:
`BORING115` identifies the call site even when a particular callback copies only
data. Use a direct call with explicit arguments, or an inline array/constant local
tuple without spread for `apply`. This syntactic boundary avoids silently treating
an unrecognized native call as an unrelated function; it is not a claim of general
JavaScript data-flow completeness. User-defined methods with the same names remain
ordinary local calls.

Use `boring add schedule|event|command <name> --from orders.create --payload
orders.queuedOrder`. Commands additionally require `--output orders.order`; events
require `--event orders.create-requested --event-version 1`; schedules require
`--input '<JSON>' --timing '<JSON>'`. Programmatically use `addTrigger` from Scaffold.
Generators inspect existing schemas/operations, refuse overwrites and roll back source
on check failure. They do not invent permissions or input data. Review schedule
idempotency: a static request ID in generated input would reuse one business intent
across every occurrence; adapt it to `ctx.occurrence.id` when that is the desired rule.

Migration: append/apply `triggerMigration`, configure exact grants, regenerate types,
update catalog readers for v5, rebuild and deploy separate processes. The fullstack
reference uses `BORING_SCHEDULE_PERMISSIONS`, `BORING_EVENT_PERMISSIONS` and
`BORING_COMMAND_PERMISSIONS`, defaulting to **no grants**; set `orders:create`
explicitly. Existing HTTP/job-only consumers require no new binding or migration.
The public additions and inspection change require the next **platform minor on
0.x**. No legacy aliases, compatibility mode, version bump, commit or publication
is implied by implementation.
