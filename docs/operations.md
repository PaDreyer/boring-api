# Operational contract

[Lifecycle](lifecycle.md) · [Deployment](cli.md) · [Inspection](inspection.md)

Every framework entry point participates in one application-owned operational
contract. Core records structured logs, correlated spans and bounded-cardinality
metrics for HTTP, controlled executions, jobs, schedules, events, commands,
publisher handoffs, event ingress and scheduler admission. Adapters export those
records; they do not own application lifecycle or change business behavior.

## Configure adapters and readiness

Setup may bind one operational adapter and any number of named infrastructure
readiness probes:

```ts
ctx.observability(createOperations(), {
    bufferSize: 1000,
    flushTimeoutMs: 1000,
});
ctx.readiness("PostgreSQL", () => database.ready(), { timeoutMs: 1000 });
```

Call these bindings directly on the setup parameter, using property access or an
exact string-literal element access: `ctx.observability(...)`,
`ctx["observability"](...)`, `ctx.readiness(...)` or `ctx["readiness"](...)`.
Context/method aliases, destructuring, receiver casts, computed, template or
asserted keys, and `.call`/`.apply`/`.bind` are rejected with positioned
`BORING113` diagnostics. This bounded form lets `boring check` and `boring inspect`
use one static lifecycle model without general value-flow analysis.
Keep the generated/Core `SetupContext` type on the setup parameter; `any`,
`unknown` and foreign structural substitutes are rejected because they erase that
shared model. Calls nested in another function or callback are not setup binding
sites and are rejected too.

`OperationalAdapter.emit(record)` must return promptly. Async sends are kept in a
bounded application-owned buffer; records beyond its limit are dropped and counted
in `boring_operational_records_dropped_total`. Adapter errors do not fail business
work. During shutdown, Core waits for buffered sends and optional `flush()` before
disposing resources registered with `onClose`. Flush is bounded; a timeout becomes
a bounded `close()` failure, but Core continues to own the real flush operation.
Registered resources are disposed only after it actually settles, and
`application.closed` retains both the timeout and any later flush rejection. An
adapter must not retain an application resource after its `flush()` settles.

Log records have stable event names and optional correlation IDs. HTTP completion
and error logs include method, the matched route pattern (or `<unmatched>`), a stable
error category, status and duration. They do not copy dynamic request paths, raw
error messages, request bodies, credentials or identity data. Every non-HTTP execution emits an
`execution.completed` record with its bounded entry-point kind, outcome and
duration; failures use error level. Delivery-specific IDs may be log attributes,
but identity and permission data are not copied. Applications remain responsible
for redacting their own custom log attributes. Attribute records are shallowly
snapshotted and frozen when emitted; values must be finite primitive values or null.

One span represents each execution. Its `traceId` is the execution correlation ID.
Durable deliveries use a fresh correlation for the attempt and link to the stored
origin correlation rather than pretending to continue a live in-process span.
Delivery IDs and attempt numbers may be span attributes; they are never metric
labels.

Framework metric labels use only bounded enums:

- `boring_executions_total{kind}`
- `boring_execution_results_total{kind,status}`
- `boring_execution_duration_ms{kind,status}`
- `boring_operational_records_dropped_total`

`application.metrics()` returns cumulative in-process counter and histogram
snapshots. It is a scrape/export boundary, not durable metric storage. Process
restarts reset it. Do not add correlation, event, tenant, actor, route parameter or
other unbounded values as labels.

## Liveness and readiness

`application.health()` is a synchronous liveness report:

```ts
{ status: "up", state: "ready" }
```

It reports `up` while the owner is ready or draining and `down` only after close.
It intentionally does not query dependencies. Liveness answers whether this process
is running; dependency failures must not trigger restart loops.

`await application.readiness()` reports whether the application admits work and
runs every setup-registered dependency probe with its own timeout. Draining or
closed applications are immediately `not_ready` without probing dependencies.
Concurrent reports share one real in-flight invocation per named probe, while each
report keeps its own timeout window. A new invocation is allowed after the shared
probe actually settles.
Probe failures expose only the stable `failed` or `timeout` reason and emit
`readiness.failed` without the infrastructure error text; they do not
mutate application state. A timeout bounds the readiness response, not the probe's
resource lifetime: shutdown keeps resources owned until the underlying probe really
settles, and a probe that overlaps shutdown cannot return a stale `ready` state.

Custom servers choose transport and status codes. The fullstack reference mounts:

- `GET /health/live`: 200 for `up`, otherwise 503.
- `GET /health/ready`: 200 for `ready`, otherwise 503.
- `GET /metrics`: the current structured metric snapshot.

Generated HTTP/worker/publisher processes still own signal handling and cleanup.
The operational API does not install global handlers, open listeners or start an
exporter. A production adapter can bridge `OperationalRecord` values to a log,
trace or metric backend without importing that SDK into routes, modules or Core.

`boring inspect` reports source locations for setup calls to `observability`,
`readiness` and `publications`. It does not execute setup or claim that a dependency
is currently healthy.
