# Durable jobs and workers

[Roles](architecture.md) · [Lifecycle](lifecycle.md) · [Inspection](inspection.md)

Jobs reuse public application operations: **job → facade → service → port → adapter**.
Core supplies discovery, payload validation, delivery and lifecycle; the optional
`@boringapi/jobs-postgres` runtime package supplies durable storage using `pg`.
Core itself has no database or development-tool dependency.

## Declaration and composition

For an API at `src/api`, declare jobs in sibling `src/jobs/<name>/job.ts`.
Names are the lowercase, slash-separated folder path, for example `orders/create`.
Each folder has one `job.ts` or compiled `job.js`. No helper files, barrels,
manual registration or alternate entry point registry are supported here.
A job exports exactly four values:

```ts
// jobs/orders/create/job.ts
import { queuedOrder } from "$modules/orders/schemas";
import type { JobHandler } from "./$types";

export const payload = queuedOrder;
export const version = 1;
export const policy = { maxAttempts: 5, retryDelayMs: 1000, timeoutMs: 30000 } as const;
export const handler: JobHandler = async ctx => {
    await ctx.services.orders.create(ctx.execution, ctx.payload);
};
```

`payload` is a data-producing Zod schema. Its input and output must be finite,
acyclic JSON values: no undefined values, Dates, bigint, functions, symbols,
accessors, sparse arrays or live runtime capabilities. Optional object properties
must be omitted rather than explicitly set to undefined. Both enqueue and execution
validate; the original JSON input is stored, so schema transforms run once at each
boundary, not twice on already transformed output. Use strict schemas when unknown
fields should fail instead of being removed. The handler result is discarded;
generated `JobHandler` returns void or Promise<void>.

`version` is a positive integer. Change it when stored inputs cannot retain their
meaning under a new implementation. Unknown names, version mismatches and payloads
that no longer validate become retained failures without calling the facade.
Changing a name/version requires an explicit drain or application-owned data migration;
there are no silent aliases or payload upgrades.

`policy` uses literal positive integers. `maxAttempts` is 1–100; durations are at most
2,147,483,647 ms. Enqueue snapshots the policy. Delivery uses the smaller of the
stored timeout, current declaration timeout and application execution timeout.
Stored retry budgets/delays remain stable after deployment. Increase the version
when changing the semantics of pending work.

Setup constructs infrastructure, registers resource cleanup immediately, binds
one adapter, and injects a named enqueue port into the owning module:

```ts
const database = createDatabase({ connectionString: ctx.config.databaseUrl });
ctx.onClose("PostgreSQL", () => database.close());
const jobs = ctx.jobs(database.jobs, {
    identity: { kind: "machine", id: "order-worker", permissions: ["orders:create"] },
});
return { orders: createOrders(database.orders, jobs.for("orders/create")) };
```

Generated `SetupContext<Config, JobInputs>` infers each enqueue input from the job's
schema. The module defines its own narrow type-only port in `ports/`, with
`enqueue(execution: ExecutionContext, payload: QueuedOrder): Promise<JobReceipt>`.
The facade's public `enqueue` operation authorizes the caller and uses this port.
HTTP calls that facade and may return 202 with `{ id }`. The framework verifies
that enqueue receives a live framework-created execution context.

`ctx.jobs` is a composition operation, sealed after setup. Its bindings and queue
adapter cannot be returned as public services or hidden behind data casts. Existing
capability/port/setup rules apply unchanged. Jobs import public schemas, generated
types, Core types, named Core errors/requirePermissions and Zod. Namespace, CommonJS
and lazy Core runtime imports are rejected so jobs cannot construct/admit another execution. They cannot import facades directly, private services,
concrete adapters, SDKs or other jobs; their handler calls injected facades.
Jobs cannot replace injected operations through `Object`/`Reflect` mutation APIs,
including element access, extracted methods and destructured aliases (`BORING113`).
`BORING116` diagnoses invalid job exports/policies and attempts to create/admit
another application execution inside a job. Dependency violations retain the
existing `BORING101`–`BORING115` codes and source locations.

## PostgreSQL persistence and delivery

Install `@boringapi/jobs-postgres` as a runtime dependency. `createPostgresJobs(pool)`
borrows an application-owned `pg.Pool`; it creates no second pool and never closes
the borrowed one. Register pool disposal in setup. Its exported `jobMigration`
belongs in the application's append-only migration list, applied explicitly before
HTTP/worker deployment. No request or worker start runs migrations. PostgreSQL 13+
is required for built-in `gen_random_uuid`; tests use PostgreSQL 17.

The adapter uses `boring_jobs` in the pool's configured search path. Queue storage
and business transactions are separate. The pool's database role must have the
necessary table privileges; queue contents are trusted application infrastructure,
not a public payload endpoint.

| Transition | Rule |
| --- | --- |
| Enqueue acknowledged | INSERT and COMMIT succeed on a dedicated connection with `SET LOCAL synchronous_commit = on`. The receipt confirms that commit, subject to PostgreSQL/storage durability configuration. |
| Claim | Atomic UPDATE from `FOR UPDATE SKIP LOCKED`; increments attempt and assigns a unique lease token. Competing workers cooperate without sharing in-process state. |
| Running | Heartbeat renews the lease every third of its duration, starting at claim. Default lease: 30 seconds; minimum: 30 ms. Use a duration suitable for database latency and process pauses. |
| Success | Handler and `application.execute` settle successfully, then the adapter confirms with the current, unexpired token. |
| Retry | Unexpected errors, deadline and cancellation retry after `min(1 hour, retryDelayMs × 2^(attempt−1))`, while attempts remain. No jitter is currently applied. |
| Permanent failure | All `ApplicationError` domain failures (including forbidden/conflict/invalid_input/not_found), unknown declarations, version/schema failures, or exhausted attempts. |
| Process crash / lease loss | After lease expiry another worker may claim. Expired final attempts become retained failures on the next claim scan. A stale owner cannot renew, succeed or fail that claim. |

Renewal and acknowledgement check the current token and lease expiry after acquiring
the row lock, including when another transaction delays that lock acquisition.

The delivery guarantee is **at least once within the configured attempt budget**,
with retained failures for work that cannot complete. It is not exactly once.
A lost enqueue acknowledgement may mean the job was committed; retrying enqueue can
create two queue records. A successful business commit followed by a lost job
acknowledgement can repeat the operation. All jobs therefore need idempotent effects
or an explicitly accepted duplicate policy. Queue IDs identify deliveries, not a
guarantee of one business effect.

Lease fencing protects queue state. It does not fence arbitrary external effects.
A process pause, connection failure or lost heartbeat may let another worker start
while the old operation still runs. The old worker signals cancellation, awaits its
operation and stops queue confirmation. Business transactions/idempotency must cope
with that overlap. A SQL query or JavaScript callback is not forcibly interrupted.

Successful and failed records are retained; there is no automatic deletion. The
adapter exposes `get(id)`, `failed(limit = 100)` (maximum 1000), and `retry(id)` for
explicit operator tooling. Retry only accepts failed records; it resets the attempt
budget and leaves name/version/input/origin unchanged, retaining the last error
until the next result. Retry cannot repair incompatible payloads or remove business
effects. Protect operator tooling through its own authorized facade or trusted
bootstrap. No HTTP administration endpoint is installed automatically. Inspect the
table for custom pagination/history/retention; per-attempt history is not provided.
Failure messages are bounded to 2,000 UTF-16 code units without splitting Unicode
pairs. The PostgreSQL adapter replaces NUL and unpaired surrogates in diagnostic
code/message text with U+FFFD so those characters cannot prevent failure retention.
This diagnostic cleanup does not rewrite job payloads; PostgreSQL JSONB's Unicode
restrictions still apply to persisted inputs.

## Identity, correlation and lifetime

Each process's setup binds an explicit **machine identity** with exact grants.
A fresh snapshot of the configured identity applies to each attempt; redeploy/restart
a worker to change its grants. Neither payload fields nor stored origin grant
permissions. Facades enforce the same business permission checks used by HTTP.
This version does not impersonate the enqueuing user or revalidate that user's
current grants at delivery: enqueue is an authorized request for machine execution.

Only the originating identity's kind/id, trusted tenant and correlation ID are
persisted as provenance. No permissions, full session, ExecutionContext, AbortSignal,
absolute deadline or callback is stored. Tenant comes from the enqueuing execution;
it still needs application-specific tenant authorization. A distinct correlation UUID
identifies every attempt; `ctx.delivery.origin.correlationId` links it to enqueue.
`delivery` also includes job id/name, attempt number and attemptId. The framework
creates each attempt's context, deadline and cancellation signal independently.

```ts
const application = await new BoringApi().createApp(absoluteApiDirectory);
// No HTTP listener is needed.
try { await application.work(); }
finally { await application.close(); }
// application.runJob() executes at most one claimed attempt and returns its status,
// or undefined when none is eligible. Bootstrap owns process signals.
```

`work({ pollIntervalMs: 1000, leaseMs: 30000 })` runs one attempt at a time.
Scale with separate workers; there is no in-process concurrency setting.
Queue I/O failures propagate to the worker bootstrap, which closes its owner and
reports failure; use the process supervisor's restart policy. Business failures
are recorded and do not stop the worker loop.

`close()` stops new claims and wakes polling immediately. It drains admitted work,
signals cancellation after the application grace period and awaits actual settlement,
including in-flight claims, heartbeats and acknowledgement. Leases continue renewing
while an admitted operation remains alive, including after shutdown's caller timeout.
Resources remain owned until work/queue I/O settle. A settled cancelled operation
can then be retried; a killed worker becomes eligible only when its lease expires.
The bootstrap/operator chooses any final forced-kill policy. Core installs no global
signal handlers. `closed` still observes eventual cleanup after `close()` times out.

## Reference, tools and migration

The fullstack reference uses `POST /orders` for direct creation and
`POST /orders/queued` for enqueueing, both with `orders:create`. Jobs call the same
`orders.create`, with the configured `order-worker` machine. The optional
`BORING_WORKER_PERMISSIONS` configuration accepts `orders:create` or the empty string
(no grants); there are no implicit wildcard or administrator permissions.

Queued orders require a caller-chosen UUID `requestId`; direct orders can use it too.
Inside the existing facade-owned transaction the PostgreSQL adapter locks that key,
looks up the previous result, and creates the order, audit row and idempotency record
atomically. Repeating the same key/data returns the original order without another
audit event. Different data under the same key fails with conflict. Distinct queue
records with the same key therefore produce one order/audit effect. The reference
has no tenant ownership model: request IDs have application-wide scope, must be
unpredictable, and are not authorization tokens. Audit attributes the actual executor.

Enqueue after a separate business commit is **not atomic with that commit**: enqueue
may fail after business state has committed, or a lost response may obscure whether
it succeeded. Use reconciliation/idempotent retries appropriate to the application.
A general transactional outbox belongs to milestone 5 and is not implemented here.

- `boring inspect --json`: catalog v4 includes jobs, payload types, version/policy,
  source locations, facade calls and the shared dependency roles. No source execution.
- `boring add job orders/create --from orders.create --payload orders.queuedOrder`:
  finds an existing `(execution, payload)` operation and public schema, validates the
  generated entry and refuses overwrites. It never generates grants or queue wiring.
- `boring dev --worker`: checked source worker, watches jobs and other application
  roots, regenerates types, drains/closes on restart; existing five-second supervisor
  kill policy applies to non-cooperative processes.
- `boring build`: includes jobs and generates portable `boring-worker.cjs` alongside
  `boring-start.cjs`. Those filenames are reserved. Deploy the complete output and
  runtime dependencies. Start separate processes with `node dist/boring-start.cjs`
  and `node dist/boring-worker.cjs`; neither needs CLI, TypeScript or ts-node.
- `boring worker [compiled-api-directory] [--out-dir ... | --project ...]` is the
  corresponding development convenience for compiled output.

This is a platform **minor release on 0.x**: new runtime APIs/conventions and an
inspection schema version change. Install the optional adapter only where needed,
append/apply migrations, configure grants, make repeated effects safe, regenerate
types and rebuild before deploying workers. Existing HTTP-only apps need no queue.
Release version changes, commits and publication are separate maintainer actions.
