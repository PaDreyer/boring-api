# Boring API

An API made from files: folders define URL paths, while `get.ts` and `post.ts` define HTTP methods. Files prefixed with `+` control shared behavior. Boring API connects them automatically at startup, without nested routers or decorators.

```text
api/
├── +setup.ts                  initialize services once
├── +auth.ts                   authentication and authorization
├── +middleware.ts             middleware for all routes
├── +envelope.ts               response format for all routes
├── +error.404.ts              error response for HTTP 404
└── items/
    ├── +middleware.ts         additional middleware for /items/* only
    ├── latest/get.ts          GET /items/latest
    └── [id]/get.ts            GET /items/:id
```

The API directory belongs to the application. It can have any name; the application passes its path to Boring API. `src` contains only the library. A separate, runnable example is available under `examples/basic`.

## Installation

`@boringapi/core` is the published Node module. It installs the executable `boring` command through the package's `bin` field:

```bash
npm install @boringapi/core zod
# or: pnpm add @boringapi/core zod
# or: yarn add @boringapi/core zod
```

After a local installation, the command is available in the application's package scripts. You can also run it directly with `npx boring`, `pnpm exec boring`, or `yarn boring`.

## CLI

The three standard commands handle loading, type generation, and validation:

```bash
boring dev                 # load ./api, generate types, and restart on changes
boring check               # generate types and check the project with TypeScript
boring start               # start the compiled API without a watcher
```

The API directory defaults to `./api`. Pass another path as a positional argument or with `--dir`. The default port is 4040.

```bash
boring dev src/api --port 3000
boring check src/api
boring start dist/api --port 3000
```

`boring dev` loads TypeScript through `ts-node`, generates types before every restart, and watches the API directory and its sibling `modules` and `infra` directories, including directories added during development. For example, `boring dev src/api` watches `src/api`, `src/modules` and `src/infra`. Files elsewhere are not watched. `boring check` checks TypeScript, file conventions, route/hook export contracts, and application import boundaries. Architecture checks are mandatory. `boring start` is intended for compiled JavaScript. `boring sync` only generates the type files.

Add these scripts to the `package.json` of an application that uses Boring API:

```json
{
  "scripts": {
    "dev": "boring dev",
    "check": "boring check",
    "start": "boring start dist/api"
  }
}
```

### Integrating with an existing server

```ts
// server.ts in the consumer application
import { join } from "path";
import { BoringApi } from "@boringapi/core";

async function main() {
    const app = await new BoringApi().createApp(join(__dirname, "api"));
    app.listen(4040);
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
```

`createApp(directory)` returns an Express application. `listen(directory, port)` starts and returns an HTTP server directly. The loader scans the specified directory at startup and requires loadable `.ts` or `.js` files.

## Adding a route

The names `get.ts`, `post.ts`, `put.ts`, `patch.ts`, `delete.ts`, `head.ts`, and `options.ts` are reserved. A `get.ts` directly inside `api/` handles `GET /`. A folder named `[id]` becomes the `:id` URL parameter. Static routes take precedence over dynamic routes. Duplicate or unknown convention files cause startup to fail.

```ts
// api/orders/[id]/get.ts
import { order, orderParams } from "../../../modules/orders/schemas";
import type { GetHandler } from "./$types";

export const params = orderParams;
export const output = order;
export const authorization = "orders:read";

export const handler: GetHandler = ctx =>
    ctx.services.orders.get({ id: ctx.params.id, actor: ctx.session });
```

The orders facade is registered in `+setup.ts`; its types flow into `ctx.services` automatically. Its public schemas define the request and response contracts. `+auth.ts` checks the `orders:read` permission. See the application structure below and `examples/basic` for the complete, runnable implementation.

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
import type { Context } from "@boringapi/core";
import { requireAccess } from "../modules/access/facade";
import type { Actor, AuthorizationRule } from "../modules/access/schemas";

export function authorize(ctx: Context, rule: AuthorizationRule): void {
    requireAccess(ctx.session as Actor, rule);
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
│       ├── facade.ts            public business operations
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
| `modules/<name>/facade.ts` | Expose business operations with explicit inputs and actor identity. Check business permissions for every caller, including jobs or server-rendered pages. |
| `modules/<name>/schemas.ts` | Share Zod schemas and inferred data types. Keep contracts independent of server clients so browser code can reuse them later. |
| `modules/<name>/internal/` | Optional private implementation details. Introduce this directory only when the facade needs to be split. |
| `infra/` | Implement storage and external clients. Keep these dependencies out of endpoint handlers. |
| `+setup.ts` | Create infrastructure and inject it into facades once per application. Return facades through the existing `ctx.services` contract. |

Other modules use a module's `facade.ts` and `schemas.ts`, never its internal files.
Keep dependencies acyclic. A facade can start as a single factory function; no
framework base class, decorator, service wrapper or repository layer is required.
Add private helpers as the module grows. Before adding a new module, look for an
existing facade that owns the business operation.

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

The example's `createOrders(store)` factory exposes `create({ input, actor })` and
`get({ id, actor })`. They require `orders:create` and `orders:read`, respectively;
`get` throws
`HttpError(404, "Order not found")` for an unknown order. These explicit errors are
handled by the normal Boring API error pipeline. The facade accepts plain values
and does not depend on an Express request or response. Non-HTTP callers must
validate untrusted input with the shared schemas and supply a trusted actor;
the facade still checks its business permissions.

The setup hook supplies the storage implementation:

```ts
// api/+setup.ts
import { createMemoryStore } from "../infra/memoryStore";
import { createOrders } from "../modules/orders/facade";
import type { Order } from "../modules/orders/schemas";

export function setup() {
    const orderStore = createMemoryStore<Order>();
    return { orders: createOrders(orderStore) };
}
```

Storage contains domain records shared by this application's requests. Actors,
sessions and other request state stay in each call. The example creates fresh
storage for each `createApp()` call; it never places records or actors in module
globals. Its in-memory adapter loses data on restart and is not a production
database integration.

### Checked import boundaries

`boring check` enforces these rules for every application. There is no disabling
flag or compatibility mode. In addition to the consumer's `tsconfig.json` files,
the command includes all TypeScript/JavaScript source in the selected API
directory and its sibling `modules`, `infra` and `web/client` directories. Unused
modules are checked too. It does not execute setup, hooks, routes or dependencies.

| Source | Allowed dependencies |
| --- | --- |
| Method files such as `get.ts` | Public `schemas` modules, type-only generated `$types`, `@boringapi/core` and `zod`. Call business operations through `ctx.services`. Other packages and Node builtins belong behind a facade. |
| Hooks other than `+setup` | Public facades/schemas, Boring API, Zod and Node helpers. Initialize SDKs and infrastructure in `+setup` and expose them through facades. |
| Root `+setup` | Public facades/schemas, infrastructure, packages and Node builtins. |
| A module's facade or private implementation | Its own files, other modules' public facades/schemas, infrastructure, packages and Node builtins. |
| Public `schemas` | Other public schemas, Zod and type-only Boring API imports. Keep runtime server code out of shared contracts. |
| Infrastructure | Other infrastructure, public schemas, packages and Node builtins. Type-only facade imports may describe an adapter contract; infrastructure must not call business facades. |
| Browser source in `web/client` | Other browser files, public schemas and browser-appropriate packages. No local server modules, Node builtins or runtime Boring API imports. |

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

For endpoint violations, diagnostics also list callable operations inferred from
`+setup` when available, such as `ctx.services.orders.get`, with their declaration
locations. No additional service registry or metadata class is required.

These are static import rules, not a JavaScript sandbox or a semantic duplicate
detector. They do not track values passed through `ctx.services`, global I/O calls
or the runtime behavior of installed packages. Keep infrastructure private to
facades and select browser-compatible dependencies for browser builds. No SPA/MPA
framework is selected by the `web/client` boundary.

Run `boring check` in development and CI. Startup still validates API structure
and runtime hook contracts; `dev`, `start`, `sync` and `createApp` do not run the
static architecture analysis. `boring inspect` and generators are planned next
and are not available commands yet. See `ROADMAP.md` in the repository for the
implementation order and `examples/basic/AGENTS.md` for the consumer workflow.

## Generated types

`boring dev`, `boring check`, and `boring sync` generate a virtual `$types` module under `.boring/types` for every route directory. The generator does not evaluate application code or duplicate schemas. The generated types reference the exports of the corresponding method file:

- `params`, `query`, and `body` are typed according to their Zod output.
- The return value of `GetHandler` or `PostHandler` must match the input of the `output` schema.
- The return value of `+setup.ts` becomes `ctx.services`.
- The return value of `authenticate()` becomes `ctx.session`. On protected routes, `session` is not optional.
- The type of the second `authorize()` parameter limits the permitted values of the `authorization` export. `boring check` also enforces this contract for handlers without generated type annotations.
- The return values of all inherited `+middleware.ts` files are merged into `ctx.locals`.

Generated files are not committed. There are two ways to make the editor resolve `./$types` in the same way as `boring check`. A simple project can extend the generated configuration from its `tsconfig.json`:

```json
{
  "extends": "./.boring/tsconfig.json",
  "compilerOptions": {
    "strict": true
  }
}
```

If the application already extends another base configuration, add only `rootDirs` instead:

```json
{
  "compilerOptions": {
    "rootDirs": [".", ".boring/types"]
  }
}
```

The configuration is created the first time you run `boring sync`, `boring dev`, or `boring check`. `boring check` sets `rootDirs` itself, so it also works without this editor setting.
The API directory must be inside the project because its location is mapped to the generated `.boring/types` directory.

## Files prefixed with `+`

The filenames form the framework's contract. Shared logic does not require manually nested Express routers.

| File | Location and lifetime | Contract |
| --- | --- | --- |
| `+setup.ts` | API root only; once per `createApp()` | `setup(ctx)` returns an object containing long-lived services. It is typed as `ctx.services`. Manual `ctx.set()` calls remain supported but cannot be inferred. |
| `+auth.ts` | API root only; for every matched route | `authenticate(ctx)` returns a session. `authorize(ctx, rule)` checks a route rule. Both exports are optional, but at least one is required. |
| `+middleware.ts` | Any URL folder; once per request from the root to the route folder | `handler(ctx)` returns new request locals. They are typed as `ctx.locals` in subsequent steps. An early response with `ctx.send()` is supported. |
| `+envelope.ts` | Any URL folder; for every successful response | `handler(ctx)` returns the formatted response or sets `ctx.payload`. The nearest file applies. |
| `+error.ts`, `+error.404.ts`, `+error.500.ts` | Any URL folder; when an error occurs | `handler(ctx, error)` returns the error response. The nearest template applies; a matching status-specific file in the same folder takes precedence. |

Middleware **stacks** along the URL path. Envelopes and error responses, by contrast, **override** an inherited template instead of being nested repeatedly. An unmatched path uses the error response defined at the API root. Empty HTTP 204 responses are not wrapped in an envelope.

Safe defaults apply when convention files are absent: no session, HTTP 401 for protected routes without a session, HTTP 403 for an authorization rule without `authorize()`, unchanged successful responses, and JSON error responses without internal server details. A default logger is provided. `+auth.ts` and `+setup.ts` replace or extend this behavior as needed. The example at `examples/basic/api/+auth.ts` uses an environment token for demonstration purposes only.

## Context and request flow

Every request receives its own `Context`. `ctx.request` and `ctx.response` are the Express objects. `ctx.params`, `ctx.query`, and `ctx.body` contain validated input. `ctx.services`, `ctx.session`, and `ctx.locals` are inferred from convention files. The `get()` and `set()` map methods remain available for dynamic edge cases; return values are the standard typed approach. Request data does not belong in global variables or the setup context.

Each route runs through: authentication → inherited middleware → session check → authorization → input validation → handler → output validation → nearest envelope → send. Every step is awaited. If an error occurs, the matching error file receives the same request context.

## Local example and checks

This section applies only when working on the `boring-api` repository. These scripts are not copied into consumer applications; those use the `boring` command from the installed package as described above. Node.js 18 or newer is required. The repository includes a `yarn.lock`.

```bash
yarn install
yarn example:dev     # run the local source against examples/basic/api
yarn example:check   # check the local example
yarn example:sync    # generate only the local example's types
yarn example:start   # start examples/basic/server.ts
yarn typecheck
yarn test
yarn build           # compile only the library into dist
```

## Publishing

A `v<version>` tag starts the release workflow. The tag must exactly match the version in `package.json`; for example, `v0.0.1` matches `"version": "0.0.1"`. Before publishing, the workflow runs the example check, TypeScript check, tests, and build. It then creates an npm tarball, publishes it through npm Trusted Publishing, and creates a GitHub Release with a checksum and automatically generated release notes.

The Trusted Publisher for `@boringapi/core` uses the following GitHub Actions settings:

- Organization or user: `PaDreyer`
- Repository: `boring-api`
- Workflow file: `release.yml`
- Permitted action: `npm publish`

Because a Trusted Publisher can only be configured for an existing npm package, publish the first version interactively once with `npm publish --access public`. Then enable the Trusted Publisher in the package settings; subsequent versions are created exclusively through matching Git tags.

For a regular patch release, `npm version patch` increments the version in `package.json`, creates a release commit, and adds the matching Git tag. Pushing afterward transfers the branch and tag, which starts the release workflow:

```bash
npm version patch
git push origin master --follow-tags
```

Use `npm version minor` or `npm version major` for minor or major releases, respectively.

The example server listens on port 4040 by default; set `PORT` to change it.

```bash
curl http://localhost:4040/health
curl http://localhost:4040/items/42
curl -X POST http://localhost:4040/echo \
  -H 'Content-Type: application/json' \
  -d '{"message":"Hello"}'
```

The responses are `{"service":"boring-api","status":"ok"}`, `{"id":"42"}`, and `{"data":{"message":"Hello"}}`. The current scope supports JSON bodies and individual dynamic segments such as `[id]`. Catch-all segments are not defined yet.

To exercise the orders module, set your own `BORING_API_TOKEN` in the shell before
starting `yarn example:dev`. The example token hook grants the `admin` role and
its explicit `orders:read` and `orders:create` permissions to a matching bearer
token; it is demonstration authentication. Use the same token in
the client shell:

```bash
curl -X POST http://localhost:4040/orders \
  -H "Authorization: Bearer $BORING_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"item":"Notebook","quantity":2}'

# Replace <id> with the ID returned by POST /orders.
curl "http://localhost:4040/orders/<id>" \
  -H "Authorization: Bearer $BORING_API_TOKEN"
```

Creation returns HTTP 201 with `{"data":{"id":"<uuid>","item":"Notebook","quantity":2}}`;
retrieval returns the same envelope with HTTP 200. Both routes require a valid
token (otherwise HTTP 401). Invalid input returns HTTP 400, and a valid but unknown
order UUID returns HTTP 404 with `{"error":{"message":"Order not found"}}`.
To add another order operation, extend the existing facade and schemas, then add
the method file that calls it. Reuse the store injected by `+setup.ts`.
