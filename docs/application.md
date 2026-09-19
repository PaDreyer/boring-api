# Routes, modules and access control

[Package README](../README.md) · [Agent guide](agent-guide.md)

Build HTTP adapters around shared business operations. This reference covers route exports, permission rules, module ownership and the enforced import boundaries.

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
throws `HttpError(403, "Forbidden")` on denial. Hooks must throw on denial;
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

This reference describes the current implementation. The accepted
[project vision](vision.md) defines the complete backend architecture; the
[roadmap](roadmap.md#milestone-1--enforce-one-application-architecture) tracks the
stricter role and invocation rules still to implement. In particular, today's
same-module private-file access and module-to-infrastructure imports are known
enforcement gaps, not the intended architectural freedom for new code.

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
│       ├── repository.ts        private storage contract
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
| `modules/<name>/repository.ts` | Define the narrow storage port needed by the service when the domain persists data. Keep the port private and expose its type through the facade for infrastructure adapters. |
| `modules/<name>/internal/` | Optional additional private implementation details when the service needs to be split. |
| `infra/` | Implement repository ports and external clients. Keep SQL and SDK calls out of the facade and service. |
| `+setup.ts` | Create infrastructure and inject it into facades once per application. Return facades through the existing `ctx.services` contract. |

Other modules use a module's `facade.ts` and `schemas.ts`, never its internal files.
`boring check` rejects imports of a module's private `service.ts` from
routes, setup, infrastructure, browser code, server pages and other modules,
including type-only imports, aliases and re-exports. A service is imported only
inside its owning module; callers use the public facade.
Keep dependencies acyclic. A facade can start as a single factory function; no
framework base class or decorator is required. Put domain behavior in a private
service and define a repository port when storage is needed. Before adding a new
module, look for the existing facade and service that own the operation.

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

The example's `createOrders(repository)` facade exposes `create({ input, actor })`
and `get({ id, actor })`. It checks `orders:create` and `orders:read`, then calls
its private service. The service validates inputs, constructs orders, uses the
repository port and raises a domain error for a missing order. The facade maps
that error to `HttpError(404, "Order not found")` for the normal Boring API error
pipeline. Neither facade nor service depends on an Express request or response.
Non-HTTP callers supply a trusted
actor; the same facade enforces permissions for them.

The setup hook supplies the storage adapter, which satisfies the module's
repository port:

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

## Checked import boundaries

`boring check` enforces these rules for every application. There is no disabling
flag or compatibility mode. In addition to the consumer's `tsconfig.json` files,
the command includes all TypeScript/JavaScript source in the selected API
directory and its sibling `modules`, `infra`, `web/client` and `web/server` directories. Unused
modules are checked too. It does not execute setup, hooks, routes or dependencies.

| Source | Allowed dependencies |
| --- | --- |
| Method files such as `get.ts` | Public `schemas` modules, type-only generated `$types`, `@boringapi/core` and `zod`. Call business operations through `ctx.services`. Other packages and Node builtins belong behind a facade. |
| Hooks other than `+setup` | Public facades/schemas, Boring API, Zod and Node helpers. Initialize SDKs and infrastructure in `+setup` and expose them through facades. |
| Root `+setup` | Public facades/schemas, infrastructure, server page adapters, packages and Node builtins. |
| A module's facade or private implementation | Its own files, other modules' public facades/schemas, infrastructure, packages and Node builtins. |
| Public `schemas` | Other public schemas, Zod and type-only Boring API imports. Keep runtime server code out of shared contracts. |
| Infrastructure | Other infrastructure, public schemas, packages and Node builtins. Type-only facade imports may describe an adapter contract; infrastructure must not call business facades. |
| Browser source in `web/client` | Other browser files, public schemas, browser-appropriate packages, `@boringapi/core/client` and type-only generated `$client`. No local server modules, Node builtins or runtime imports from the core server entry point or development packages (`compiler`, `typegen`, `analyzer`, `build`, `scaffold`, `dev`, `cli`), including subpaths and aliases. |
| Server pages in `web/server` | Other server page files, public facades/schemas, Boring API and Zod. Setup injects existing facades. No infrastructure or SDK imports; modules and infrastructure cannot import pages. |

Routes and hooks are entry points: application files must not import them.
Other modules cannot access a module's private files, including via a TypeScript
path alias or a re-export. A facade may re-export its **own** implementation files
to make selected operations public. Shared server helpers belong in a named module
or infrastructure, rather than an additional `utils` or `services` directory.

The checker resolves import targets using TypeScript and real filesystem paths.
It checks ES imports/re-exports, literal `import(...)`, literal `require(...)`,
`import = require(...)` and import types, including JavaScript when `checkJs` is
disabled. Computed module paths, aliased loaders, `require.resolve` and custom
loaders through `node:module` are rejected because their dependencies are not
fully checked by this model. Unresolved imports are errors too.

Runtime dependencies between modules must be acyclic, including dependencies
through private files or infrastructure. Use declaration-level `import type` or
`export type` for erased dependencies; these still respect import boundaries but
do not create runtime cycle edges. Other imports, including inline type
specifiers, are conservatively treated as runtime dependencies.

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

For endpoint violations, diagnostics also list callable operations inferred from
`+setup` when available, such as `ctx.services.orders.get`, with their declaration
locations. No additional service registry or metadata class is required.

These are static import rules, not a JavaScript sandbox or a semantic duplicate
detector. They do not track values passed through `ctx.services`, global I/O calls
or the runtime behavior of installed packages. Keep infrastructure private to
facades and select browser-compatible dependencies for browser builds. The
reference uses React, but the browser transport and import boundaries are
independent of the UI framework.

Run `boring check` in development and CI. Startup still validates API structure
and runtime hook contracts. `start` and `createApp` do not run static checks;
`dev` and `sync` may analyze source to refresh browser contracts, but do not gate
startup on those diagnostics. `boring inspect` uses the same mandatory checks
as `boring check`, as do the `boring add` generators. Follow the
[agent workflow](agent-guide.md) when extending an application.
