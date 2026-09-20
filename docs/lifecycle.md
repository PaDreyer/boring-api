# Application and execution lifecycle

[Agent guide](agent-guide.md) · [Roles](architecture.md) · [HTTP contexts](reference.md)

An application owns its dependencies. An execution owns its identity and lifetime.
HTTP, server pages and controlled non-HTTP invocations call the same injected
facades. Durable jobs, schedules, event delivery and command runtimes are separate
roadmap milestones; `execute` supplies their common foundation, not those runtimes.

## Configuration and construction

Root-only `api/+config.ts` exports `schema` (Zod) and `load(env)` (data, optionally
asynchronous). Core snapshots the supplied `ApplicationOptions.env` or `process.env`,
awaits `load`, validates with `schema.parseAsync`, and snapshots the result **before
calling setup**. Configuration and identity snapshots are acyclic plain records,
arrays and primitives, without functions, accessors, class instances or symbols.
Missing configuration means an empty object. Invalid configuration rejects startup;
setup has not acquired anything. Loading source modules itself must not acquire
resources: construct them inside setup, not during module evaluation.
Passing `{ env: process.env }` explicitly has the same snapshot semantics as omitting
the option. Custom environment records still undergo plain-data validation.

```ts
// api/+config.ts
import { z } from "zod";
import type { ConfigEnvironment } from "./$types";

export const schema = z.object({ databaseUrl: z.string().url() });
export function load(env: ConfigEnvironment) {
    return { databaseUrl: env.DATABASE_URL };
}
```

`Config` and `SetupContext<Config>` are generated from the schema output. Config
imports only Zod, public schemas and Core types. Infrastructure construction belongs
in `+setup`, which runs once for each application instance:

```ts
export function setup(ctx: SetupContext) {
    const database = createDatabase({ connectionString: ctx.config.databaseUrl });
    ctx.onClose("PostgreSQL", () => database.close());
    return { orders: createOrders(database.orders) };
}
```

Register cleanup **immediately after acquisition**, before the next fallible step.
An adapter must clean up resources it acquires before its constructor/factory can
return. Await readiness probes in setup when the application requires them; creating
a lazy database pool alone does not prove database availability. Migrations remain
explicit actions. The fullstack reference uses a lazy pool and does not run a probe
or migration on startup.

Setup may expose only the existing checked facade/page operations and data. Cleanup
callbacks and adapters are never services. Setup is sealed after startup; late
registration/writes fail. HTTP gets only the setup logger view, not ownership APIs.
Each `createApp` has independent configuration, services and cleanup registrations.

On setup failure Core awaits all registered cleanups, in reverse registration order.
A cleanup failure does not skip later cleanup. `LifecycleError.errors` retains original
startup and cleanup errors, nesting resource names without replacing their causes.
Resource disposal is awaited even if it is slow: arbitrary cleanup cannot be safely
preempted. A stalled startup/cleanup can therefore require operator intervention.

## The public application handle

```ts
import { BoringApi } from "@boringapi/core";
import type { Services } from "./api/$types";

const application = await new BoringApi().createApp<Services>(absoluteApiDirectory, {
    env: process.env,
    executionTimeoutMs: 30_000,
    shutdownGraceMs: 5_000,
    shutdownTimeoutMs: 10_000,
});
const server = await application.listen(4040);
// application.http is the Express adapter for mounting into a parent Express app.
// await application.listen(4040, parent) owns that parent's HTTP listener too.
await application.close();
```

`BoringApi.listen(directory, port, options)` constructs an application and opens its
listener, returning the same application handle. Listener startup failure disposes
its application. The returned `Server` from `application.listen` supports address
inspection; shutdown belongs to `application.close`, not `server.close` alone.
If shutdown overlaps a pending listener start, `listen` rejects instead of leaving
startup pending. It joins the same shutdown promise: successful shutdown produces
`ExecutionError("unavailable")`; cleanup/timeout failures preserve both causes in
`LifecycleError`.
Custom listeners opened outside this method must be stopped by their owner as well.

`ready` is true only after successful setup and before shutdown; it describes framework
admission, not ongoing infrastructure health. `state` is `ready`, `draining` or `closed`.
Core installs no process-global signal handlers. Generated production startup, CLI
start and development workers wire SIGINT/SIGTERM to `close`. Custom bootstraps do so
explicitly. Development workers use a one-second grace and four-second timeout,
before the existing supervisor's five-second forced termination.
Timers and other background handles acquired by the application also need registered
cleanup; shutdown cannot discover or dispose unregistered handles.

Shutdown is ordered:

1. Stop accepting executions and listeners synchronously. HTTP through an existing
   connection gets 503; `execute` rejects with `ExecutionError("unavailable")`.
2. Stop listening and drain already accepted executions. After `shutdownGraceMs`,
   signal cooperative cancellation on every remaining execution.
3. Wait for actual execution settlement, including awaited `finally` blocks and
   HTTP error hooks. An early HTTP response does not end a still-running handler.
4. Close remaining owned HTTP sockets, then await registered cleanups in reverse
   order. Continue after failures. Mark the application closed.

Concurrent and repeated `close()` calls share exactly one promise, including its
failure. After `shutdownTimeoutMs`, that promise rejects with `ShutdownTimeoutError`.
**Resources remain owned while execution or disposal is still running.** After
calling close, `application.closed` observes eventual completion and any cleanup
failures. Timing out does not forcibly stop JavaScript, issue a database rollback
from another task, free a pool under active queries, or terminate the process.
The bootstrap/operator owns a final process-kill policy if work never cooperates.
All timeouts are positive integer milliseconds, at most 2,147,483,647; shutdown
timeout must be at least the grace period.

## Execution context and trusted identity

A framework-created `ExecutionContext<Identity>` contains:

| Member | Meaning |
| --- | --- |
| `identity` | Trusted `{ kind: "user" \| "machine", id, permissions }`, plus application data; undefined for anonymous HTTP. |
| `tenantId` | Optional trusted tenant identifier; it does not itself authorize tenant access. |
| `correlationId` | A new UUID, or the explicit trusted non-HTTP correlation ID. |
| `deadline` | Absolute Unix time in milliseconds; a caller may shorten, never extend, the application limit. |
| `signal` | AbortSignal for cooperative cancellation. |
| `throwIfAborted()` | Throws when cancelled, expired or already ended; also checks elapsed time synchronously. |

HTTP starts an anonymous execution before JSON parsing. Authentication returns an
identity-bearing session (or writes it through the untyped Map escape hatch). Core
snapshots it once before middleware/authorization; an optional session `tenantId`
becomes the trusted tenant. Generated contexts expose the inferred identity as
`ctx.execution.identity`, with the same protection guarantees as `ctx.session`.
Subsequent session Map writes do not replace the established execution identity.
HTTP headers do not automatically grant identity, tenant, correlation or permissions.
The auth provider must validate credentials and tenant membership. Client disconnect
signals cancellation; hooks, route, error handling and awaited work retain one context.

Controlled callers supply a trusted identity explicitly, including permissions for
machines. Put adapters for these invocations under sibling `executions/`:

```ts
// executions/create-order.ts
import type { Application } from "@boringapi/core";
import type { Services } from "../api/$types";
import type { Actor } from "$modules/access/schemas";
import type { CreateOrder } from "$modules/orders/schemas";

export function createOrder(app: Application<Services>, identity: Actor, input: CreateOrder) {
    return app.execute({ identity }, ({ execution, services }) =>
        services.orders.create(execution, input));
}
```

Bootstrap imports and calls this ordinary function; there is no second service
registry. `execute` admits one callback against the services created by setup,
awaits its result, checks cancellation before/after it, and ends the context in
`finally`. Optional caller `signal`, `timeoutMs`, `tenantId` and `correlationId` are
execution-local. Context and identity snapshots are frozen. Do not start detached
work, retain contexts on shared objects, or return them. Await all work that uses
application resources. Execution `finally` blocks perform per-call cleanup; setup
cleanup is for application resources. Context signals abort at completion too, so
retained contexts reject reuse. Abort does not race the operation with a rejected
promise: non-cooperative code is still awaited and still owns its resources.

## Business access, errors and transactions

Facades enforce permissions for every caller, independently of route declarations.
`requirePermissions` has exact grants, no machine/admin/wildcard bypass, and throws
`ApplicationError("forbidden", "Forbidden")`. Resource ownership and tenant policy
remain domain rules, verified by application tests.

`ApplicationError` carries `code`, `message` and optional `details`. HTTP alone maps
`forbidden` to 403, `not_found` to 404, `conflict` to 409 and `invalid_input` to 400.
`ExecutionError` maps deadline to 504 and cancellation/unavailability to 503.
Unexpected errors remain 500, with details hidden by the default HTTP response.
Existing HTTP `HttpError` remains for transport hooks/handlers; business facades
must migrate to domain errors or `ApplicationError`. Non-HTTP callers receive the
original business or execution error, with no artificial HTTP response wrapper.

The orders facade chooses the transaction boundary and passes the execution to its
transaction port. The PostgreSQL adapter uses one connection for BEGIN, service
queries and COMMIT. It checks cancellation before acquisition, before BEGIN and
before COMMIT, rolls back failures and always releases the connection. A failed
rollback discards the connection and preserves both failures in `LifecycleError`.
Cancellation during a query waits for that driver operation; pg does not magically
cancel through an AbortSignal. A successful COMMIT cannot be undone when cancellation
arrives afterwards. Thus a cancelled call may have committed; future delivery
runtimes must add idempotency/reconciliation where required.

## Static enforcement and migration

The common scanner owns root `+config`; the role model owns `executions/`. Checks,
inspection v3, typegen, generated consumers, watching and portable builds all use
these conventions. Execution entries import public schemas, generated types, Core
and Zod, and call injected operations. They cannot import private services, facades
or concrete adapters. Source includes unused execution files. Configuration/identity
contracts remain data-only. The sole facade/page input exception is the **exact Core
ExecutionContext as the first positional parameter**; nested contexts, augmented
capability types, raw signals, arbitrary callbacks, factory capture and context
results remain forbidden. Aliases preserve symbol identity, not a spelling exemption.
Fabricated context casts, module context storage and business `HttpError` uses get
`BORING115`, including fabrication through `any` annotations, typed collections
(`Map`, `Set`, weak/readonly variants and nested containers), and context variables
in application-lived facade/page factory or setup closures. Context variables and
collections created inside an individual operation remain local to that invocation.
Renaming or extending a context type does not change these lifetime rules.
Input-only context parameters on injected ports do not imply stored context.
Existing capability-erasure and setup exposure checks remain mandatory.

Static checks do not prove permission policy, awaited asynchronous work, arbitrary
reflection/global side channels, resource registration completeness, or database
commit outcomes. Runtime and application tests cover supported lifecycle paths.

This is a **breaking platform minor release on 0.x**, not a patch:

- `createApp` returns an application owner; mount `.http` and close the owner.
  `BoringApi.listen` also returns the owner. Wire signals in custom bootstraps.
- Move configuration parsing into `+config`, read `ctx.config` in setup and register
  acquired resources with `ctx.onClose` immediately.
- Authentication returns explicit user/machine identities. Pass `ctx.execution` to
  operations needing identity/lifetime; non-HTTP callers use `application.execute`.
- Replace business `HttpError` and status-based permission assertions with domain
  error codes. Regenerate types and update inspection readers for schema version 3.
- Move the removed `modules/<name>/repository.ts` convention into type-only
  `ports/<name>.ts`. Business rules stay in `service.ts`/`services/`, and concrete
  storage stays in `infra/`. There is no extra repository implementation layer.

No compatibility mode is provided. Version bump, tagging and publishing are separate
release actions; these changes do not publish a release.
