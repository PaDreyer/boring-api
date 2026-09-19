# Agent guide

Use this guide when building an application with `@boringapi/core`. Follow the
project's own instructions and use the guide shipped with its installed version.
The [README](../README.md) is the package entry point; the linked references cover
detailed contracts. This is consumer guidance, not framework contributor guidance.

## Start with the existing application

1. Read the project's `AGENTS.md`, `package.json`, TypeScript configuration and
   root `+setup.ts`. Identify the selected API directory and existing scripts.
2. Install dependencies using the project's package manager, then run its sync
   script after checkout. In an initialized project: `npm run sync`.
3. Run `npm run inspect`, or `npm run inspect -- --json`. Read the reported source
   locations for relevant operations, schemas, access rules and inherited hooks.
   Inspection is static; it does not execute application modules. If it fails,
   fix the diagnostics and run it again.
4. Extend the module that already owns the behavior. Search public facades and
   schemas even if they are not yet exposed through `ctx.services`. Keep one
   implementation of each business operation across HTTP, jobs and web pages.

Direct CLI commands below assume `api/`. Pass `--dir src/api` (or the actual API
path) and `--project <tsconfig>` when needed. Generated package scripts already
include the API path. In a workspace repository, run these commands in the
consumer workspace (or select it with the package manager). Each consumer owns
its generated `.boring/` files and configuration; build local framework packages
before invoking their CLI. See [inspection](inspection.md) and [CLI configuration](cli.md).

## Decide where the change belongs

| Change | Place and pattern |
| --- | --- |
| Another route for existing behavior | A method file under `api/`, calling the existing `ctx.services` operation. |
| New behavior in an existing domain | Extend `modules/<name>/facade.ts` and reuse its schemas and injected dependencies. |
| A genuinely separate domain | Generate a module, implement its public operations, then wire its factory in root `+setup.ts`. |
| Shared data contract | `modules/<name>/schemas.ts`; derive TypeScript types from Zod. Keep it browser-safe. |
| Growing implementation | Private files in the owning module; add `internal/` when useful. Other modules import only `facade` or `schemas`. |
| Database, configuration or external SDK | Sibling `infra/`; construct adapters in setup and inject narrow interfaces into facades. |
| Authentication or route access | Root `+auth.ts`; reuse the application's identity provider and permission catalog. |
| Shared request behavior | Named `+middleware`, `+envelope` or `+error` hooks at the appropriate URL scope. |
| SPA | Sibling `web/client/`; reuse shared schemas and the application's typed API client. |
| Server-rendered page / MPA | Sibling `web/server/`; receive existing facades through setup, validate input and escape HTML. |

Small facades are plain factory functions. No `Facade`/`Service` base class,
decorator, separate registry or forwarding-only service/repository layer is
needed. Keep module dependencies acyclic. [Exact import rules and diagnostics](application.md#checked-import-boundaries).

## Implement a feature

1. Define or reuse the public input/output schemas. Keep browser-safe contracts
   separate from server implementations and infer types from the schemas.
2. Implement the business operation in the owning facade. Pass typed inputs and
   a trusted actor explicitly; enforce permissions and resource ownership there
   so non-HTTP callers receive the same protection. Validate untrusted input
   from non-HTTP callers with the shared schemas too.
3. If a new dependency is needed, construct it once in root `api/+setup.ts`,
   inject it into the facade, and return the facade for `ctx.services`.
4. Add the thin HTTP adapter. Import method-specific handlers from `./$types`,
   select schemas, declare access, call `ctx.services`, set status when needed,
   and return the payload.
5. Check inherited middleware, envelope and error hooks before exposing another
   URL. Add tests for the behavior and relevant validation/permission boundaries.
   Finish with the project's check, test and build scripts.

Use `npx boring add module invoices` only for a new domain. It generates
`facade.ts` and `schemas.ts`; implement them and wire setup yourself.
`npx boring add endpoint 'orders/lookup/[id]/get' --from 'orders/[id]/get'` reuses
an existing compatible adapter. Review its access declarations and arguments.
Without a matching adapter, the generator produces a typed 501 stub. Generators
preserve existing files and reject incompatible inherited hooks. [Generator details](cli.md#generate-an-application-module-or-endpoint).

## A complete small feature

`boring init` generates this public health operation. These four files show the
whole path from a shared schema to HTTP without a storage or authentication stub.
Use this shape for small modules; protected business operations additionally need
the permission checks described below.

```ts
// modules/health/schemas.ts
import { z } from "zod";

export const health = z.object({ status: z.literal("ok") });
export type Health = z.infer<typeof health>;
```

```ts
// modules/health/facade.ts
import type { Health } from "./schemas";

export function createHealth() {
    return { get(): Health { return { status: "ok" }; } };
}
```

```ts
// api/+setup.ts
import type { SetupContext } from "./$types";
import { createHealth } from "$modules/health/facade";

export function setup(_ctx: SetupContext) {
    return { health: createHealth() };
}
```

```ts
// api/health/get.ts
import { health } from "$modules/health/schemas";
import type { GetHandler } from "./$types";

export const output = health;
export const handler: GetHandler = ctx => ctx.services.health.get();
```

Run `npm run sync`, `npm run check`, `npm test` and `npm run dev` in the generated
project. `GET /health` returns HTTP 200 with `{"status":"ok"}`.

## Preserve the framework contracts

- **Imports:** `$modules/<name>/schemas` for contracts, `$modules/<name>/facade`
  where business imports are allowed, and `$infra/<path>` for infrastructure.
  Endpoints call injected services rather than importing facades or storage.
  Same-module imports can stay relative. Aliases do not bypass import boundaries.
- **Generated types:** routes use `GetHandler`, `PostHandler`, etc. from `./$types`.
  Hooks use their generated context types. Annotate hook contexts or use
  `satisfies` so returned services, sessions and locals retain inferred types.
  Never edit or commit `.boring/`; run sync to refresh editor configuration.
- **Request lifetime:** one context per request. Keep actors, sessions and locals
  out of module globals and long-lived services. Setup constructs dependencies;
  authentication returns a session and middleware returns request locals.
- **Permissions:** reuse existing names and explicit role grants. Declare a
  permission string, non-empty `allOf` or non-empty `anyOf` with `as const`.
  Authorization requires a session; throw on denial (`false` does not deny).
  Check permissions in business operations too. [Access control](application.md#permission-authorization).
- **Responses:** return payloads. Input schemas run before the handler (400 on
  failure), output schemas before the envelope (500 on failure). `ctx.send()` is
  an intentional early response that bypasses output validation and the envelope.
  Empty handlers return 204; the nearest envelope wraps successful payloads unless
  `envelope = false`. [Request lifecycle and hook contexts](reference.md).
- **Checks:** `boring check` is mandatory; fix `BORING` diagnostics at their source.
  Dev/start are not substitutes for static checks. The import checker does not
  detect duplicated business logic or prevent passing raw storage via services;
  retain the ownership rules above.

## Reuse storage and web integrations

Keep one application-owned database adapter/pool, shared through injected facades.
Reuse the project's migration history; run migrations explicitly before starting,
never on ordinary requests. Business operations choose transaction boundaries;
the adapter executes all transaction queries on the same connection. Parameterize
SQL and validate returned rows with shared schemas. The PostgreSQL reference uses
an append-only migration list with checksums. Follow an existing project's
migration tooling rather than creating a competing mechanism.

For an SPA, reuse one `createClient` from `@boringapi/core/client` and
`import type { ApiRoutes } from "$client"`. A sibling `web/client` directory enables
contract generation. Share schemas for form validation; keep server facades and
Node imports out of browser code. Client types describe declared successful
responses, not runtime validation. Query arrays must be nonempty; omit optional
filters instead of passing `[]`.

For an MPA, inject the existing facade into `web/server` from setup. Pages pass a
trusted actor, validate input and escape HTML. Their route declares access,
sets the HTML content type and `envelope = false`, then returns the page. No
extra database query layer or HTTP call back into the same server is needed.
See [database and web patterns](web.md) for client contracts and a runnable reference.

## Develop, verify and deploy

- Use the project's scripts. `npm run dev` watches the API and sibling `modules`,
  `infra` and `web` source; frontend tooling handles browser assets separately.
- Finish changes with `npm run check`, `npm test` and `npm run build` (or the
  project's equivalent). Add meaningful behavior tests, including direct facade
  permission tests where callers can bypass HTTP.
- Build with `boring build`; plain `tsc` does not rewrite `$modules`/`$infra`.
  `npm start` runs the last successful API build. Copy the complete build output,
  including `.boring-build.json`, and install runtime dependencies for deployment.
- A custom server uses `BoringApi.createApp()` or `listen()` with an explicit API
  directory. For combined static hosting, build browser assets separately and
  start that custom server. Source entry points using aliases need the compiler
  registered before they are loaded. [Bootstrap and deployment details](cli.md).

If an import fails, first run sync and check the selected API path and generated
editor mappings. If the checker rejects a dependency, move it to its owning layer;
do not hide it behind dynamic loading or add a second implementation.
