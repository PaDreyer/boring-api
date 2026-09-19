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
   handlers from `./$types`; never edit generated files.
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
schemas, but cannot import local server code, Node builtins or runtime Boring API.
Schemas themselves stay independent of server implementations. These checks
cover imports, not values passed through `ctx.services` or arbitrary JavaScript
side effects; keep the documented ownership of storage and business operations.

The token hook is a demonstration controlled by `BORING_API_TOKEN`. The memory
store is non-persistent demonstration storage. Do not embed credentials or present
either as a production integration. `boring init` and `boring add` are planned
commands and are not available yet.
