# Working on this consumer application

This application demonstrates Boring API's standard module structure. The root
repository's AGENTS.md also applies while editing this bundled example.

## Extend existing functionality first

1. Run `yarn example:inspect` (or `yarn example:inspect --json` for structured
   output) before adding code. In a standalone consumer, use `boring inspect`
   with its API directory. Locate the existing operation, schemas, access rules
   and effective hooks, then read the reported source files. Inspection does not
   execute application modules. Fix any check diagnostics before continuing.
2. Extend the existing domain module when the change belongs to it. The orders
   facade already provides `create` and `get`; do not introduce a second orders
   service or access its storage from an endpoint.
3. Reuse Zod schemas and infer types from them. Route files import method-specific
   handlers from `./$types`. Hooks import their generated `SetupContext`,
   `AuthenticationContext`, `AuthorizationContext`, `MiddlewareContext`,
   `EnvelopeContext` or `ErrorContext` from `./$types` too; never edit generated
   files. Annotate the context, or use `satisfies` with a generated handler type,
   to preserve inferred service, session and locals return types. Import public schemas
   with `$modules/<name>/schemas` and facades with `$modules/<name>/facade`
   where the import boundaries permit them. Keep same-module imports relative.
   Import infrastructure in setup with `$infra/<path>`.
4. Read `modules/access/schemas.ts` for the permission catalog and
   `modules/access/facade.ts` for role grants and `requireAccess`. Declare the
   required permission in the endpoint's `authorization` export and check it
   again in the business operation. Reuse existing names; add new permissions
   and role grants explicitly. Use `allOf`/`anyOf` with `as const` for multiple
   requirements; never use a bare array or check a role name in an endpoint.
5. Verify success, failure and permission behavior, then run the repository's
   `yarn example:check`, `yarn typecheck`, `yarn test` and `yarn build` commands.
   In a standalone consumer, use its own `boring check` script and test/build commands.

## Application boundaries

- `api/` contains HTTP routes and convention hooks. Endpoints choose schemas,
  declare access rules, call facades and set response status. Return payloads.
- `modules/<name>/facade.ts` exposes business operations. Accept typed inputs and
  an explicit actor; enforce business permissions inside these operations so
  callers outside HTTP cannot bypass them. Do not accept an Express context.
- `modules/<name>/schemas.ts` exposes shared Zod contracts and inferred types.
  Non-HTTP callers validate untrusted data with these schemas before calling a
  facade, just as Boring API validates route input.
- Keep helpers private in the facade until an `internal/` directory is useful.
  Other modules use only `facade.ts` and `schemas.ts`, never implementation files.
- `infra/` owns storage and external clients. `api/+setup.ts` initializes these
  dependencies once per application, injects them into facades, and returns the
  facades through `ctx.services`. Do not expose raw storage to endpoints.
- Keep actors, sessions and other request state out of shared services. The demo
  store contains domain records and is created separately for each application.
- Do not add services/repositories that merely forward calls. Keep module
  dependencies acyclic and keep infrastructure independent of endpoints.

`boring check` enforces import boundaries for all application source, including
unused modules. There is no opt-out. Method files import only public schemas,
generated types, Boring API and Zod; hooks can also use public facades. Only
`+setup` imports infrastructure or SDKs in the API tree. Do not import routes or
hooks from other files, or move server helpers into an unclassified directory.
Use declaration-level `import type` for adapter contracts and other erased
dependencies. Runtime module dependencies must be acyclic. Literal imports,
requires, aliases and re-exports are checked; computed paths and custom loaders
are errors. Fix diagnostics at their source instead of bypassing the checker.

If browser source is added, put it under `web/client/`. It can import public
schemas, `@boringapi/core/client` and type-only generated `$client` contracts,
but cannot import local server code, Node builtins or the runtime core server entry.
Server presentation belongs in `web/server/` and receives existing facades from
setup; it must not import storage. See `examples/fullstack` for a complete reference.
Schemas themselves stay independent of server implementations. These checks
cover imports, not values passed through `ctx.services` or arbitrary JavaScript
side effects; keep the documented ownership of storage and business operations.

The token hook is a demonstration controlled by `BORING_API_TOKEN`. The memory
store is non-persistent demonstration storage. Do not embed credentials or present
either as a production integration.

Generators are available through the consumer CLI. While working in this
repository, invoke them with `yarn ts-node src/cli.ts add module <name> --dir
examples/basic/api` or `yarn ts-node src/cli.ts add endpoint <path/method> --dir
examples/basic/api`. Prefer extending the existing orders module. To expose the
same order read operation at another URL, generate `orders/lookup/[id]/get` with
`--from orders/[id]/get`. This reuses the adapter, schemas, service and access rule;
review the new URL's intended behavior. A new adapter without a compatible
template returns 501 until implemented. New modules need business operations
and explicit setup wiring; generators never replace existing files.

`yarn example:build` compiles the example with `tsconfig.example.json` into
`.boring/example-build`, including its relative imports of the local library.
The compiled entry is `examples/basic/server.js` within that output directory.
Standalone consumers use `boring build`; plain `tsc` does not rewrite `$modules` or `$infra`.
For IDE support, extend `.boring/tsconfig.json` or preserve its alias mapping
when using your own `paths`. Custom TypeScript servers/tests register the source
compiler from `@boringapi/core/register` before importing application modules.
