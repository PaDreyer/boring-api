# Routes, modules and access control

[Package README](../README.md) · [Agent guide](agent-guide.md)

Build HTTP adapters around shared business operations. This reference covers route exports, permission rules, module ownership and the enforced import boundaries. Application configuration,
resource cleanup and HTTP/non-HTTP execution share the [lifecycle contract](lifecycle.md).

## Adding a route

The names `get.ts`, `post.ts`, `put.ts`, `patch.ts`, `delete.ts`, `head.ts`, and `options.ts` are reserved. A `get.ts` directly inside `api/` handles `GET /`. A folder named `[id]` becomes the `:id` URL parameter. Static routes take precedence over dynamic routes. Duplicate or unknown convention files cause startup to fail.

Request bodies use JSON. Dynamic paths support individual segments such as `[id]`;
catch-all segments are not defined.

```ts
// api/orders/[id]/get.ts
import { order, orderParams } from "$modules/orders/schemas";
import type { GetHandler } from "./$types";

export const params = orderParams;
export const output = order;
export const authorization = "orders:read";

export const handler: GetHandler = ctx =>
    ctx.services.orders.get({ id: ctx.params.id, actor: ctx.session });
```

The orders facade is registered in `+setup.ts`; its types flow into `ctx.services` automatically. Its public schemas define the request and response contracts. `+auth.ts` checks the `orders:read` permission. See [Application modules](#application-modules) below and the [basic example](https://github.com/PaDreyer/boring-api/tree/master/examples/basic) for a runnable implementation.

| Method file export | Effect |
| --- | --- |
| `handler: GetHandler` | Required; types the context and return value from this file. Other methods use `PostHandler`, `PatchHandler`, and so on. |
| `params`, `query`, `body` | Optional Zod schemas for URL parameters, query parameters, and the JSON body. |
| `output` | Optional Zod schema for the response before the envelope is applied. |
| `authentication = true` | Requires a session from `+auth.ts`; returns HTTP 401 without one. |
| `authorization = rule` | Requires a session and passes `rule` to `authorize()` in `+auth.ts`. |
| `envelope = false` | Skips the inherited envelope for this route. |

Invalid input returns HTTP 400; invalid output returns HTTP 500. A handler with no return value and no `ctx.payload` returns HTTP 204. Setting `ctx.payload = value` is an alternative to returning a value. `ctx.status(201)` sets the success status. `ctx.send(value)` sends immediately, bypassing `output` validation and the envelope.

## Permission authorization

Declare the capability a route requires. Roles bundle permissions; endpoints and
business operations check permissions rather than role names. The optional
`PermissionRule<Permission>` type and `requirePermissions(granted, rule)` helper
are exported by `@boringapi/core`. They work with the existing `authorize()` hook;
custom authorization contracts remain supported.

Keep an application-owned catalog outside `api/`, using `resource:action` names:

```ts
// modules/access/schemas.ts
import type { PermissionRule } from "@boringapi/core";

export const permissions = {
    "orders:read": "Read orders",
    "orders:create": "Create orders",
} as const;

export type Permission = keyof typeof permissions;
export type AuthorizationRule = PermissionRule<Permission>;
export interface Actor {
    readonly permissions: readonly Permission[];
}
```

Use one of these declarations in a method file:

```ts
export const authorization = "orders:read";
```

```ts
// Both permissions are required.
export const authorization = {
    allOf: ["orders:read", "orders:create"],
} as const;
```

```ts
// At least one permission is required.
export const authorization = {
    anyOf: ["orders:read", "orders:create"],
} as const;
```

Keep `as const` for object rules so TypeScript preserves the permission literals
and non-empty tuples. Bare arrays, empty lists, nested rules and objects with
both `allOf` and `anyOf` are invalid. The helper also rejects malformed rules at
runtime with a `TypeError` (HTTP 500), even when the caller has permissions. It
matches names exactly, with no role-name exceptions or wildcard expansion.

In `modules/access/facade.ts`, the example explicitly maps `viewer` to
`orders:read`, `creator` to `orders:create`, and `admin` to both. Its
`permissionsForRoles(roles)` returns a fresh, deduplicated union for each caller.
Add grants explicitly when introducing a permission; `admin` does not
automatically acquire new permissions.

`authenticate()` resolves the trusted identity and role assignments on the
server, then returns a session with the effective permissions. Never use role or
permission lists supplied directly in request input. The example's
`BORING_API_TOKEN` hook returns `{ roles, permissions }` for its demonstration
identity. Its authorization hook delegates to the shared access facade:

```ts
// In api/+auth.ts, alongside authenticate().
import type { AuthorizationContext } from "./$types";
import { requireAccess } from "$modules/access/facade";
import type { AuthorizationRule } from "$modules/access/schemas";

export function authorize(ctx: AuthorizationContext, rule: AuthorizationRule): void {
    requireAccess(ctx.session, rule);
}
```

The facade's `requireAccess(actor, rule)` calls
`requirePermissions(actor.permissions, rule)`. The library helper accepts an
array or a read-only set of granted names, returns normally on success, and
throws `ApplicationError("forbidden", "Forbidden")` (mapped to HTTP 403) on denial. Hooks must throw on denial;
returning `false` does not deny access. Unexpected hook errors remain HTTP 500.
Any `authorization` declaration already requires a session (HTTP 401 without
one), so `authentication = true` is redundant on these routes.

The second `authorize()` parameter supplies the route rule type. `boring check`
checks every route against it, including handlers without a `$types` annotation,
without executing application modules. With `PermissionRule<Permission>`, it
rejects misspelled names and invalid combinations. This is static validation;
startup does not interpret custom rules, and unchecked JavaScript rules are
validated by the helper when authorization runs.

Business operations call the same access facade, protecting jobs and other
non-HTTP callers as well. Resource ownership and tenant membership still need
checks inside the business operation after loading the resource: `orders:read`
alone does not establish access to a particular order. The bundled orders
example has no tenant or ownership model.

## Application modules

The [role contract](architecture.md) defines the shared catalog, dependency and
invocation matrix, splitting conventions and migration. The checker enforces these
boundaries within modules as well as between them. The [vision](vision.md) and
[roadmap](roadmap.md) distinguish this foundation from future runtimes and lifecycle.

Use this structure when building an application with Boring API:

```text
app/
├── api/                         the explicitly selected API directory
│   ├── +setup.ts                initialize dependencies and expose facades
│   ├── +auth.ts                 authenticate and check route access rules
│   └── orders/
│       ├── post.ts              POST /orders
│       ├── +error.404.ts         missing-order response
│       └── [id]/get.ts           GET /orders/:id
├── modules/
│   ├── access/
│   │   ├── facade.ts            role grants and shared permission checks
│   │   └── schemas.ts           permission catalog and actor/rule types
│   └── orders/
│       ├── facade.ts            public operations and orchestration
│       ├── service.ts           private business rules
│       ├── ports/storage.ts        private storage contract
│       └── schemas.ts           public Zod schemas and inferred types
└── infra/
    └── memoryStore.ts           demonstration storage adapter
```

The `modules` and `infra` directories are siblings of the selected API directory,
even if it is named something other than `api`. Only the API directory is scanned
for routes and hooks. These module names describe the standard application
structure; they do not introduce automatic service registration or additional
reserved `+` files.

| Boundary | Responsibility |
| --- | --- |
| Endpoints | Select input/output schemas, declare route access rules, call `ctx.services.<module>` and set HTTP status. |
| `modules/<name>/facade.ts` | Expose operations with explicit inputs and actor identity. Check access for every caller and coordinate private services, transactions and dependencies. |
| `modules/<name>/schemas.ts` | Share Zod schemas and inferred data types. Keep contracts independent of server clients so browser code can reuse them later. |
| `modules/<name>/service.ts` | Implement domain rules and use cases without HTTP or database driver imports. Keep this file private to its module. |
| `modules/<name>/ports/storage.ts`, `ports/publications.ts` | Define the narrow storage and effect ports needed by the service. Export types only. Setup and adapters import these contracts directly; other modules cannot. |
| `facade/`, `services/`, `schemas/`, `ports/` inside the module | Split the corresponding role into named files; every part retains that role’s restrictions. Generic `internal/` and helper files are rejected. |
| `infra/` | Implement storage ports and external clients. Keep SQL and SDK calls out of the facade and service. |
| `+setup.ts` | Create infrastructure and inject it into facades once per application. Return facades through the existing `ctx.services` contract. |

Other modules use public root facades and schemas. Only the owning facade imports
and invokes services. Services cannot import peer services, facades, concrete
infrastructure, packages other than Zod, or Node APIs. They receive effect/storage
ports through arguments. Facades can import Core and Zod, their own role parts,
services and port types, and other public facades/schemas. Business modules cannot
import concrete infrastructure, including type-only dependencies and aliases.
Keep dependencies acyclic. Adapters import public schemas and port types directly.

Public facades export named functions and types. Factories return explicit objects
of locally owned operations; facade parts may re-export other parts of that facade.
Operations accept/return data, never callbacks or nested callable capabilities.
The exact Core `ExecutionContext` may be the first positional argument; see the
[lifecycle contract](lifecycle.md) for its narrow exception and ownership rules.
Unknown and `any` contracts require validation/narrowing before crossing the boundary.
Factory parameters describe data, own ports or public facades. Re-exporting services,
returning raw implementations, mutable composition and capability-erasing assertions
are diagnosed. These structural rules apply to unused exports as well.

For example, the orders module shares these contracts between its create and get
endpoints:

```ts
// modules/orders/schemas.ts
import z from "zod";

export const createOrder = z.object({
    item: z.string().trim().min(1),
    quantity: z.number().int().min(1).max(100),
});
export const order = createOrder.extend({ id: z.string().uuid() });
export const orderParams = order.pick({ id: true });
export type CreateOrder = z.infer<typeof createOrder>;
export type Order = z.infer<typeof order>;
```

The basic example's `createOrders(store)` facade exposes `create({ input, actor })`
and `get({ id, actor })`. It checks `orders:create` and `orders:read`, then calls
its private service. The service validates inputs, constructs orders using the injected ID capability, uses the
storage port and raises a domain error for a missing order. The facade maps
that error to `ApplicationError("not_found", "Order not found")` for the normal Boring API error
pipeline. Neither facade nor service depends on an Express request or response.
Non-HTTP callers supply a trusted
actor; the same facade enforces permissions for them.

The setup hook supplies the storage adapter, which satisfies the module's
storage port:

```ts
// api/+setup.ts
import { createMemoryStore } from "$infra/memoryStore";
import { createOrders } from "$modules/orders/facade";
import type { Order } from "$modules/orders/schemas";

export function setup() {
    const orderStore = createMemoryStore<Order>();
    return { orders: createOrders(orderStore) };
}
```

Storage contains domain records shared by this application's requests. Actors,
sessions and other request state stay in each call. The example creates fresh
storage for each `createApp()` call; it never places records or actors in module
globals. Its in-memory adapter loses data on restart and is not a production
database integration. For persistent storage and web interfaces, see the
[database and web patterns](web.md).

When a committed operation must emit an event, add a domain-named publication port
and include it in the facade-owned transaction unit. The service invokes that port
beside its business writes; the infrastructure adapter stages the intent with the
same database client. Do not publish from a route, entry declaration, service
global or post-commit callback. See [reliable publication](publications.md).

## Checked import boundaries

`boring check` enforces these rules for every application. There is no disabling
flag or compatibility mode. In addition to the consumer's `tsconfig.json` files,
the command includes all TypeScript/JavaScript source in the selected API
directory and its sibling `modules`, `infra`, `jobs`, `schedules`, `events`,
`commands`, `executions`, `web/client` and `web/server` directories. Unused
modules are checked too. It does not execute setup, hooks, routes or dependencies.

| Source | Allowed dependencies |
| --- | --- |
| Method files such as `get.ts` | Public `schemas` modules, type-only generated `$types`, `@boringapi/core` and `zod`. Call business operations through `ctx.services`. Other packages and Node builtins belong behind a facade. |
| Jobs in `jobs/<name>/job.ts` | Public schemas, generated JobHandler, Core and Zod; calls injected facades. [Durable delivery](jobs.md). |
| Controlled entries in `executions/` | Public schemas, type-only generated types, Core and Zod. Receive an application owner and call injected facades inside `application.execute`. |
| Root `+config` | Public schemas, Zod and Core types. Export a data-producing schema and configuration loader. |
| Hooks other than `+setup` and `+config` | Public facades/schemas, Boring API, Zod and Node helpers. Initialize SDKs and infrastructure in `+setup` and expose them through facades. |
| Root `+setup` | Public facades/schemas, infrastructure, server page adapters, packages and Node builtins. |
| Facades and their `facade/` parts | Own services, port types, schemas and facade parts; other public facades/schemas; Core and Zod. |
| Services and `services/` parts | Public/own schemas, own port types, Zod and Core types. No peer services, facades, concrete infrastructure, SDKs or Node APIs. |
| `ports/` files | Type-only contracts using schemas, own ports and Core types; no runtime code. |
| Public `schemas` | Other public schemas, Zod and type-only Boring API imports. Keep runtime server code out of shared contracts. |
| Infrastructure | Other infrastructure, public schemas, packages and Node builtins. Import port types directly; even type-only facade imports are rejected. |
| Browser source in `web/client` | Other browser files, public schemas, browser-appropriate packages, `@boringapi/core/client` and type-only generated `$client`. No local server modules, Node builtins or runtime imports from the core server entry point or development packages (`compiler`, `typegen`, `analyzer`, `build`, `scaffold`, `dev`, `cli`), including subpaths and aliases. |
| Server pages in `web/server` | Other server page files, public facades/schemas, Boring API and Zod. Setup injects existing facades. No infrastructure or SDK imports; modules and infrastructure cannot import pages. |

Routes and hooks are entry points: application files must not import them.
Other modules cannot access a module's private files, including via a TypeScript
path alias or a re-export. A facade may re-export only its **own facade parts**, never services.
Schema parts are public only through root schemas. Port types are shared with
setup and adapters through their explicit files. Shared server helpers belong in a named module
or infrastructure, rather than an additional `utils` or `services` directory.

The checker resolves import targets using TypeScript and real filesystem paths.
It checks ES imports/re-exports, literal `import(...)`, literal `require(...)`,
`import = require(...)` and import types, including JavaScript when `checkJs` is
disabled. Public operation/setup boundaries require explicit ES exports and
checkable types (TypeScript or JSDoc). Service references require named ES imports;
CommonJS and lazy service loading receive an unsupported-boundary diagnostic. Computed module paths, aliased loaders, `require.resolve` and custom
loaders through `node:module` are rejected because their dependencies are not
fully checked by this model. Unresolved imports are errors too.

Runtime dependencies between modules must be acyclic, including dependencies
through private files or infrastructure. Declaration-level `import type` and
`export type`, and clauses consisting entirely of inline `type` specifiers, are
erased dependencies. They still respect import boundaries but do not create runtime
cycle edges. Mixed, empty and side-effect imports retain runtime edges.

Diagnostics have stable codes and source locations:

| Code | Meaning |
| --- | --- |
| `BORING101` | Endpoint or hook imports a dependency outside its allowed boundary. |
| `BORING102` | Import accesses another module's private implementation. |
| `BORING103` | Runtime dependency cycle between modules. |
| `BORING104` | Import of a route/hook, or infrastructure calling a business facade. |
| `BORING105` | Browser code or shared schemas import server code. |
| `BORING106` | Unresolved dependency or unsupported module loader/path. |
| `BORING107` | Dependency outside the application structure or misplaced module file. |
| `BORING108` | Invalid `$modules`/`$infra`/`$client` path or an editor alias mapping that differs from the application convention. |
| `BORING109` | Server page imports infrastructure/SDKs, or server code outside setup imports pages. |
| `BORING110` | Business role imports concrete infrastructure, an SDK or a Node API. |
| `BORING111` | Port contains runtime implementation. |
| `BORING112` | Public export, operation or dependency contract exposes an implementation/capability or has an unchecked type. |
| `BORING113` | Invalid setup exposure or dynamic/mutable capability composition. |
| `BORING116` | Invalid job declaration, policy, handler or execution-admission bypass. |
| `BORING115` | Invalid configuration/lifecycle boundary, fabricated or stored execution context, or HTTP errors in business operations. |
| `BORING114` | Service value escapes its owning facade call, peer invocation, or unsupported service loading. |

For endpoint violations, diagnostics also list callable operations inferred from
`+setup` when available, such as `ctx.services.orders.get`, with their declaration
locations. No additional service registry or metadata class is required.

Setup returns an explicit object of traced facade/page factory results, public
operations and data. Raw adapters, services, inline wrappers and spreads are
rejected. Const aliases retain their origin; class instances and dynamic object
construction are not public facade contracts. Imperative `ctx.set`/`ctx.assign`
writes remain untyped but follow the same exposure restrictions. Call setters
directly; destructuring, renamed bindings and assignment aliases are rejected.
Schema annotations and calls accepting data must not erase callable capabilities.
Export service operations as named functions rather than objects of methods.

These checks establish source roles, dependency edges and supported value boundaries.
They are not a JavaScript sandbox or a semantic duplicate detector. Global I/O,
arbitrary reflection and installed-package behavior are not made safe by a passed
check. Correct permissions, resource ownership and execution-state isolation still
need behavior tests alongside the [implemented lifecycle](lifecycle.md). Do not use casts,
reflection or global side channels to evade the structural contract.

Run `boring check` in development and CI. Startup still validates API structure
and runtime hook contracts. `start` and `createApp` do not run static checks;
`dev` and `sync` may analyze source to refresh browser contracts, but do not gate
startup on those diagnostics. `boring inspect` uses the same mandatory checks
as `boring check`, as do the `boring add` generators. Follow the
[agent workflow](agent-guide.md) when extending an application.

Schedules, event consumers and application commands use the complete [trigger contract](triggers.md), including setup grants, PostgreSQL migration, static checks, generation and separate compiled process startup.
