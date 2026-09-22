# Reliable event publication

[Durable jobs](jobs.md) · [Events](triggers.md) · [Lifecycle](lifecycle.md)

Boring API couples a business database commit to an event-publication intent with
a transactional outbox. The framework does not claim atomicity between PostgreSQL
and an external broker. Instead, the business transaction stores a stable event
intent, a separate publisher repeatedly hands that event to the durable event
ingress, and the ingress deduplicates the stable event ID.

This is an **at-least-once** contract. A publisher can crash after event acceptance
but before acknowledging the outbox row, so it can publish the same event again.
The durable ingress accepts that repeat without creating another delivery for the
same consumer version. External transports and consumers still need idempotency.
There is no exactly-once, global ordering or per-aggregate ordering guarantee.

## Stage inside the business transaction

Domain code depends on a named, typed publication port. The PostgreSQL adapter
implements that port using the same `PoolClient` that writes the business state:

```ts
// modules/orders/ports/publications.ts
export interface OrderPublications {
    created(order: Order): Promise<void>;
}

// inside infra/db/database.ts, while BEGIN is active
const intent = eventPublication(execution, {
    id: order.id,
    type: "orders.created",
    version: 1,
    payload: order,
}, { maxAttempts: 10, retryDelayMs: 1000, timeoutMs: 30_000 });
await stagePostgresEvent(client, intent);
```

`eventPublication` accepts only a live framework-created execution and snapshots
only the trusted producer identity kind/id, optional tenant and correlation.
Permissions are never persisted as grants. Trusted tenant, event type and event ID
derive the stable publication ID, matching the event-ingress identity. Reusing that
identity with a different version, content or producer is a `publication_conflict`;
an identical retry reuses the existing intent. The returned intent is deeply
immutable. The PostgreSQL staging boundary validates its complete structure and
rederives its ID before issuing SQL. Pass that returned object directly to the
staging adapter; reconstructed, deserialized or spread copies are not trusted
publication capabilities and are rejected before database I/O.

`stagePostgresEvent` borrows the caller's transaction and never commits. A rollback
therefore removes both business writes and the intent. PostgreSQL
`synchronous_commit = on` is the reference durability setting before reporting a
successful business commit. Apply `publicationMigration` after `jobMigration`.

The owning facade selects the transaction. Its service writes business state and
calls the publication port before that transaction returns. Routes, jobs,
schedules, events and commands must all reuse this same facade path; no entry point
may publish after an independent commit.

## Bind and run the publisher

Setup binds the outbox lane to the application-owned durable adapter and an
explicit machine identity:

```ts
ctx.publications(database.jobs, {
    identity: { kind: "machine", id: "order-publisher", permissions: [] },
});
```

Keep this as a direct call on the setup parameter: `ctx.publications(...)` or
`ctx["publications"](...)`. Context/method aliases, destructuring, receiver casts,
computed, template or asserted keys, and `.call`/`.apply`/`.bind` are rejected with
positioned `BORING113` diagnostics. This intentionally small syntax keeps checking
and inspection on the same source model; use the direct form instead of adding
value-flow indirection to composition.
The setup parameter retains its generated/Core `SetupContext` type; `any`,
`unknown`, foreign structural substitutes and calls nested in another function or
callback are rejected rather than guessed through deeper flow analysis.

The publisher identity authenticates the process; the event consumer has its own
machine identity and grants. Stored producer permissions are not trusted or
replayed. Run the generated compiler-free process separately from HTTP, workers,
schedulers and consumers:

All event declarations in one application share the consumer claim lane and setup
identity. Horizontally scaled consumers therefore need the union of permissions
required by those handlers; disjoint-grant consumers can claim each other's events
and turn a business denial into a permanent delivery failure.

```bash
node dist/boring-publisher.cjs
# development only
boring dev --publisher
```

The publisher reuses the queue's claim, lease, heartbeat, retry and fencing
protocol. Competing processes use `FOR UPDATE SKIP LOCKED`. A stale publisher
cannot acknowledge a row after lease loss. Shutdown stops admission, awaits an
in-flight handoff/acknowledgement, flushes operational records and then closes
resources.

The handoff enters the ordinary durable event ingress. Consumer matching,
fan-out, retry and failure inspection therefore remain the event contract in
[triggers.md](triggers.md). A missing or incompatible consumer is retryable until
the intent's attempt budget is exhausted; the failed row remains available for
operator inspection and explicit replay through the queue adapter.

## Recovery and retention

The failure windows are intentional and tested:

| Failure point | Result |
| --- | --- |
| Before business commit | Business writes and publication intent roll back together. |
| After business commit, before publisher claim | A fresh publisher claims the retained intent. |
| During handoff | The lease expires or failure policy schedules a retry. |
| After event acceptance, before outbox acknowledgement | The publisher retries; stable ingress deduplication prevents duplicate consumer deliveries. |
| After outbox acknowledgement | The successful row remains until explicit retention cleanup. |

Successful publication rows are retained by default. Operators may call
`database.jobs.prunePublications(beforeUnixMs, limit)` in a separately owned
maintenance action. It removes only succeeded publication rows older than the
cutoff, in bounded batches; pending, running and failed rows are never pruned.

The fullstack reference publishes `orders.created` from the existing
order/audit/idempotency transaction. Its consumer calls `orders.observeCreated`
through the same facade and records an idempotent projection. The real PostgreSQL
test exits one process immediately after the business commit, kills another after
event acceptance, starts fresh publisher/consumer instances and proves recovery,
deduplication and rollback.
