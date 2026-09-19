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

The standard commands handle loading, discovery, type generation, and validation:

```bash
boring dev                 # load ./api, generate types, and restart on changes
boring check               # generate types and check the project with TypeScript
boring inspect             # find existing routes, operations, schemas and hooks
boring inspect --json      # the same catalog in a versioned machine-readable format
boring build               # check and compile the consumer application
boring start               # start the compiled API without a watcher
```

The API directory defaults to `./api`. Pass another path as a positional argument or with `--dir`. The default port is 4040.

```bash
boring dev src/api --port 3000
boring check src/api
boring build src/api
boring start dist/api --port 3000
```

`boring dev` loads TypeScript through `ts-node` and the Boring API import transformer, generates types before every restart, and watches the API directory and its sibling `modules` and `infra` directories, including directories added during development. For example, `boring dev src/api` watches `src/api`, `src/modules` and `src/infra`. Files elsewhere are not watched. `boring check` checks TypeScript, file conventions, route/hook export contracts, and application import boundaries. Architecture checks are mandatory. `boring start` loads compiled JavaScript. `boring sync` generates types and the editor configuration. Use `--project path/to/tsconfig.json` with `dev`, `check`, `inspect` or `build` to select another TypeScript configuration.

Add these scripts to the `package.json` of an application that uses Boring API:

```json
{
  "scripts": {
    "dev": "boring dev",
    "check": "boring check",
    "inspect": "boring inspect",
    "build": "boring build",
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

### Module shortcuts, editor support and builds

Use `$modules/<name>/schemas` for shared contracts and `$modules/<name>/facade`
for business operations where the import boundaries permit them. `$modules/`
always names the `modules/` directory beside the selected API directory:
`boring dev src/http` maps it to `src/modules/`. Imports within the same module
can stay relative. The shortcut does not grant access to another module's
private files or let endpoints import facades directly.

Run `boring sync src/api` once after a fresh checkout and extend the generated
configuration. For an application under `src/`:

```json
{
  "extends": "./.boring/tsconfig.json",
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "moduleResolution": "node",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"]
}
```

The generated `paths`, `baseUrl` and `rootDirs` settings give the ordinary
TypeScript language service import-path and member completion, hover types,
definition navigation, symbol rename and auto-imports. No Boring API editor
extension, language server or running development server is needed. Configure
your editor to prefer non-relative imports if it should always suggest the
shortcut. The same configuration supports the generated `./$types` imports.

An application's own `paths` object replaces inherited mappings. Preserve the
generated `$modules/*` entry when adding other aliases; targets are relative to
the effective `baseUrl`. `check`, `inspect` and `build` report `BORING108` at
affected imports if the editor would resolve the shortcut differently. Custom
aliases still need their own runtime/build support: only `$modules/` is rewritten.
One generated configuration describes one selected application; separate
applications should have separate consumer project roots/configurations.

`boring build src/api` runs the same mandatory checks as `boring check`, then
compiles the application to CommonJS. It uses the project's `rootDir` and
`outDir`, defaulting to the API's parent directory and `<project>/dist`.
The build rewrites `$modules` imports, re-exports, literal dynamic imports and
CommonJS requires to relative file paths. These paths follow TypeScript's emitted
extensions, including `.jsx` with `jsx: "preserve"`. Declaration output also
receives resolved paths, including nested import types, and the generated handler
types. Source maps retain source locations. The output runs with ordinary Node
or `boring start dist/api`.

Build output must stay inside the consumer project and outside application source
and `.boring/types`. The first build requires an empty output directory; subsequent
successful builds replace their own output, removing stale routes. The default
`dist` directory is excluded from TypeScript's default file search, just like an
explicit `outDir`. Failed checks
leave the previous build intact. This command does not support `outFile`, separate
`declarationDir`, `composite`, `incremental` or declaration-only builds. It does not
bundle dependencies or copy arbitrary assets. Plain `tsc` does not rewrite the shortcut.

`boring dev` uses the same import transformer through `ts-node`. For JavaScript
modules with separate `.d.ts` declarations, the editor uses the declarations and
the source compiler loads the executable JavaScript companion. For a custom
source server or test runner, register it **before loading application modules**
in a small JavaScript bootstrap outside the scanned API directory:

```js
// bootstrap.cjs
const { join } = require("node:path");
const { registerTypeScript } = require("@boringapi/core/register");
const stop = registerTypeScript(join(__dirname, "src/api"));
require("./src/server.ts");
// Call stop() when the compiler is no longer needed.
```

Run this with `node bootstrap.cjs`. JavaScript tests can use an equivalent
registration-only file with `node --test --require ./test/register.cjs`.
TypeScript test files outside the application's source directory also need their
test runner's TypeScript support, for example
`node --test -r ts-node/register -r ./test/register.cjs test/*.test.ts`.
Use relative imports from those tests into the application; the registered
compiler handles `$modules` inside application source. The registration accepts an
optional second argument naming a TypeScript configuration file and is scoped to
the API's parent directory. Use an absolute API path. Run `boring check` separately
for source type and architecture checks. Compiled applications need no registration.

## Adding a route

The names `get.ts`, `post.ts`, `put.ts`, `patch.ts`, `delete.ts`, `head.ts`, and `options.ts` are reserved. A `get.ts` directly inside `api/` handles `GET /`. A folder named `[id]` becomes the `:id` URL parameter. Static routes take precedence over dynamic routes. Duplicate or unknown convention files cause startup to fail.

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
| `BORING108` | Invalid `$modules` path or an editor alias mapping that differs from the application convention. |

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
static architecture analysis. `boring inspect` uses the same mandatory checks
as `boring check`. Generators are planned next. See `ROADMAP.md` in the repository
for the implementation order and `examples/basic/AGENTS.md` for the consumer workflow.

## Discover existing functionality

Run `boring inspect` before adding an endpoint or business operation. It lists
routes, callable services exposed through `ctx.services`, and exports from all
public `modules/<name>/facade` and `schemas` files, including unused modules.
Follow the reported source location and extend an existing module when the
operation belongs there. No registry, metadata class or duplicated catalog is needed.

```bash
boring inspect src/api
boring inspect src/api --json > api-catalog.json
```

For example, the orders application exposes `ctx.services.orders.create` and
`ctx.services.orders.get`, with their parameter and return types and implementation
locations. Each route also shows input/output schema types, authentication and
authorization declarations, middleware in execution order, and the selected
envelope and error hooks. Public exports include signatures, inferred types,
source locations and JSDoc descriptions in JSON; re-exports point to their definitions.
Type-only exports remain types, including through import aliases and re-export
chains; they are not offered as runtime operations. Generic operation signatures
use the instantiated constraints and defaults of the returned service.

Inspection uses TypeScript source analysis. It does not import or execute
application setup, hooks, schemas, routes or dependencies. Each run regenerates
`.boring/types` and reads the current source; no inspection cache needs updating.
Invalid structure, contracts, types or architecture produce diagnostics on stderr
and exit status 1, with no catalog on stdout. Fix these errors and run inspection
again. Successful `--json` output is exactly one JSON object on stdout.

### JSON contract, version 1

The root object contains these fields:

| Field | Contents |
| --- | --- |
| `schemaVersion` | `1`. Breaking changes to the catalog structure increment this value; readers should ignore additional fields. |
| `apiDirectory` | Selected API path relative to the consumer project root. |
| `setup`, `auth` | Setup and authentication/authorization hook locations, or `null` when absent. |
| `routes` | Method, URL path, handler location/return types, `input`, `output`, `access`, and effective `hooks`. |
| `services` | Callable services inferred from the return type of `+setup`, with exact `ctx.services` access expressions and operation signatures. |
| `modules` | Public facade/schema exports, including callable exports, schemas, values and types. |
| `unmatchedErrors` | Root error hooks used when no route matches. |

Locations have `{ "file": "modules/orders/facade.ts", "line": 17, "column": 9 }`,
with project-relative forward-slash paths and one-based positions. Routes follow
registration order: static segments before parameters and explicit HEAD before
GET at the same path. Modules, services and exports sort by name; the catalog has
no timestamps or absolute project-root field.

Route `input.params`, `input.query`, `input.body` and `output` are `null` when
absent; otherwise each has `source`, `inputType` and `outputType`. These describe
the Zod input and parsed output, including transforms. Types and signatures are
TypeScript descriptions, not JSON Schema. A handler's declared return type can
be `unknown` without an output schema. Response status, early `ctx.send()` calls
and envelope transformations are not inferred as final HTTP response schemas.

`access.authentication` and `access.authorization` contain a declaration or
`null`. Declarations distinguish `kind: "literal"` with a `value`, explicit
`kind: "undefined"`, and `kind: "expression"` with source text and a TypeScript
type. Literal syntax and references to constants can be read statically; calls,
mutable declarations and other computed values remain expressions. This describes
source declarations, not changes caused by runtime side effects. `access.session`
is `required`, `optional`, or `conditional` when a computed declaration prevents
a static decision. Authorization hooks themselves are never evaluated.

`hooks.middleware` is ordered root to leaf. `hooks.envelope` reports the nearest
hook, its route declaration, and whether it is enabled (`true`, `false`, or
`"conditional"`); a missing hook has `source: null`. It still follows the normal
204 and early-response rules. `hooks.errors.generic` and `server` report the
generic and 5xx fallbacks; `statuses` maps explicitly configured statuses to their
effective handlers. Selection checks the nearest scope first: exact status,
then that scope's 500 hook for server errors, then its generic hook, before
walking upward. A `null` location means the framework's default error response.

Service discovery lists public callable properties of returned service objects and
directly returned functions. This includes composed objects and the common callable
properties of object unions. Private and protected methods are excluded, including
ECMAScript `#private` methods. Values stored only through imperative Map writes
or hidden behind `any` have no statically discoverable signatures. Inspect the
reported public entry points when more implementation detail is needed.

## Generated types

`boring dev`, `boring check`, `boring inspect`, `boring build`, and `boring sync` generate a virtual `$types` module under `.boring/types` for every directory containing routes or hooks, including hook-only directories. The generator does not evaluate application code or duplicate schemas. The generated route types reference the exports of the corresponding method file:

- `params`, `query`, and `body` are typed according to their Zod output.
- The return value of `GetHandler` or `PostHandler` must match the input of the `output` schema.
- The return value of `+setup.ts` becomes `ctx.services`.
- The return value of `authenticate()` becomes `ctx.session`. On protected routes, `session` is not optional.
- The type of the second `authorize()` parameter limits the permitted values of the `authorization` export. `boring check` also enforces this contract for handlers without generated type annotations.
- The return values of all inherited `+middleware.ts` files are merged into `ctx.locals`.

Hooks also import their application-specific contexts from `./$types`. These
types retain every member of the full request `Context`; there is still one
context object shared throughout the request. Their names distinguish the type
guarantees at each phase. Setup runs once per application and keeps its separate
`SetupContext`:

| Hook | Generated context | Available application data |
| --- | --- | --- |
| `+setup` | `SetupContext` | The setup logger and Map API. Returned services are inferred for subsequent requests. |
| `authenticate` in `+auth` | `AuthenticationContext` | Inferred services; session is `undefined` and middleware locals are not available yet. |
| `authorize` in `+auth` | `AuthorizationContext` | Inferred services, a required session, and completed middleware locals for routes declaring authorization. |
| `+middleware` | `MiddlewareContext` | Inferred services, an optional session and only the preceding middleware's locals. |
| `+envelope` | `EnvelopeContext` | Validated input, output payload, session and completed locals for routes using this envelope. Nearest overrides and `envelope = false` are respected. |
| `+error`, `+error.<status>` | `ErrorContext` | Inferred services, optional session and partial locals, including values before middleware overwrites. Input remains `unknown` because the error may precede validation. |

Authentication, authorization and middleware run before input validation, so their
`params`, `query` and `body` remain `unknown`. Shared hooks receive unions when
their applicable routes differ. An unused envelope receives a general request
context until routes use it. Error contexts also cover failures before hooks run.
Without an output schema, an envelope infers payloads from handler return types;
if a handler can return `undefined`, the payload remains `unknown` because an
earlier hook may have assigned it.

Annotate a hook's context and let TypeScript infer its return value. The complete
example in `examples/basic/api/+auth.ts` uses `AuthenticationContext` for credential
verification and `AuthorizationContext` for permission checks. The returned
session type flows into authorization and routes without a manual session cast.

The corresponding `SetupHandler`, `AuthenticationHandler`,
`AuthorizationHandler<Rule>`, `MiddlewareHandler`, `EnvelopeHandler` and
`ErrorHandler` types are generated in the relevant hook directories too. Use
`satisfies` when checking a function against a handler type while preserving its
inferred return type:

```ts
// api/+middleware.ts
import type { MiddlewareHandler } from "./$types";

export const handler = ((ctx) => ({
  requestId: ctx.request.header("x-request-id") ?? "request"
})) satisfies MiddlewareHandler;
```

`Services`, `Session` and `Locals` are exported from each generated module for
reuse. `Locals` describes the completed middleware chain at that directory;
`MiddlewareContext` exposes only the preceding part of that chain. Avoid a broad
handler annotation on setup, authentication or middleware when its return value
must be inferred for other files.

Generated files are not committed. There are two ways to make the editor resolve `./$types` in the same way as `boring check`. A simple project can extend the generated configuration from its `tsconfig.json`:

```json
{
  "extends": "./.boring/tsconfig.json",
  "compilerOptions": {
    "strict": true
  }
}
```

If the application already extends another base configuration, add the equivalent
settings instead. For an API at `api/` and modules at `modules/`:

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "rootDirs": [".", ".boring/types"],
    "paths": { "$modules/*": ["modules/*"] }
  }
}
```

For `src/api`, use `src/modules/*`. Merge this entry with any other explicit
`paths` entries. The generated configuration is refreshed by `sync`, `dev`,
`check`, `inspect` and `build`. Checks set `rootDirs` themselves; `$modules`
imports additionally require matching editor settings as described above.
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
yarn example:inspect # discover the example's routes and existing operations
yarn example:sync    # generate the local example's types and editor configuration
yarn example:build   # compile the example and its local library into .boring/example-build
yarn example:start   # start examples/basic/server.ts
yarn typecheck
yarn test
yarn build           # compile only the library into dist
```

The example keeps an explicit `$modules/*` entry in the repository's tsconfig
because the repository also generates types for independent test applications.
`tsconfig.example.json` selects its application build. Run the compiled example
with `node .boring/example-build/examples/basic/server.js`.

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
