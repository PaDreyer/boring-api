# Making Boring API easy for agents

Implement these steps in order. The aim is to make existing code easy to find,
reuse and extend, with few decisions and mechanically checked boundaries.
Prefer named conventions, inferred types and small functions over configuration
or mandatory layers. This roadmap describes planned work; the README documents
the current contract.

Design decision: start with plain factory functions, without framework `Facade`
or `Service` base classes. File conventions and inferred exports already identify
roles and signatures. Revisit this during steps 2 and 3 if checks or inspection
need explicit metadata. A small `defineFacade(...)` helper is also an option;
inheritance should earn its place through concrete shared behavior. No such
helper or base class is part of the current API.

## 1. Establish the application structure

Status: complete (2026-09-19).

- Keep HTTP routes and hooks in the consumer's explicitly selected API directory.
- Place business modules in a sibling `modules/<name>/` directory. `facade.ts`
  exposes business operations; `schemas.ts` exposes shared Zod contracts and
  inferred types. Add `internal/` only when implementation details need it.
- Place database connections and external clients in a sibling `infra/`
  directory. Initialize dependencies in `+setup.ts` and expose facades through
  the existing, inferred `ctx.services` object.
- Pass input and actor identity explicitly to business operations. Never pass
  Express request/response objects or retain request state in shared services.
- Keep a small facade small: do not require a service and repository wrapper for
  every operation. Existing public `createApp`, `listen` and context APIs stay
  compatible.
- Provide a complete example with multiple endpoints using one facade, shared
  schemas, authorization, a business error and a clearly labeled in-memory
  adapter. Document how to extend the existing module.
- Add consumer-facing agent instructions with a reuse-first workflow.
- Ensure `boring dev` restarts when the example's sibling modules or
  infrastructure change, so the documented development workflow remains usable.

Acceptance: an order can be created and retrieved through the same facade;
unauthorized access and missing orders have tested responses; business operations
can also be called without HTTP; separate application instances do not share
example storage. The README explains the module boundaries and what is currently
enforced. Run the repository's example check, typecheck, tests and build.

Delivered in `examples/basic`: shared orders facade and schemas, POST/GET routes,
per-application demo storage, a scoped missing-order response and consumer agent
instructions. The dev watcher covers sibling modules/infrastructure, including
new and recreated directories. Validation: `yarn example:check`, `yarn typecheck`,
`yarn test` (26 passing tests) and `yarn build` all passed. Module import boundaries
were deferred to step 2.

## Permission authorization (before step 2)

Status: complete (2026-09-19).

- Added the reusable `PermissionRule<Permission>` type and
  `requirePermissions(granted, rule)` helper. Rules are a permission string or a
  non-empty `allOf`/`anyOf` list; denial throws HTTP 403 and malformed rules remain
  programming errors. Custom `authorize(ctx, rule)` contracts stay supported.
- The example's access module owns the typed permission catalog, explicit role
  grants and shared checks. Authentication returns effective permissions;
  endpoints and the orders facade require `orders:read` or `orders:create`.
- `boring check` validates authorization exports against the hook's rule type
  even when handlers omit generated type annotations, without executing modules.
- Updated the README and consumer agent workflow. Verified allowed and denied
  requests, combined rules, role unions, request isolation, non-HTTP access,
  invalid rules and compatibility with custom authorization contracts.

Validation: `yarn example:check`, `yarn typecheck`, `yarn test` (34 passing tests)
and `yarn build` all passed. Architecture enforcement is tracked separately in step 2.

## 2. Enforce architecture boundaries with `boring check`

Status: complete (2026-09-19).

- Reject database and external SDK imports from endpoints.
- Reject access to another module's internals; expose business operations through
  `facade.ts` and data contracts through `schemas.ts`.
- Reject module dependency cycles and infrastructure imports of endpoints.
- When a browser application is present, reject server imports from browser code.
- Resolve aliases and re-exports using TypeScript's module and symbol information;
  define how dynamic imports and other unanalyzable dependencies are handled.
- Give diagnostics stable codes, source positions, the broken rule and a useful
  repair direction. Include existing public operations when relevant.
- Enforce the rules for every application, without an opt-out or migration mode.
  There are no existing consumers to preserve. Remove the legacy `scan()` alias
  and prototype migration branches; keep `createApp()` and `listen()` as the API.
- Preserve parity between startup and check for structural API conventions.

Acceptance: fixtures demonstrate forbidden direct DB imports and cross-module
internal imports, including aliases/re-exports; legitimate facade and schema use
passes. Checks do not execute application modules. Structural checks cannot
promise to detect semantically duplicate business functions.

Delivered: mandatory static architecture analysis with diagnostic codes
`BORING101`–`BORING107`, source locations and inferred public-operation hints.
Checks cover unused modules, aliases, re-exports, literal CommonJS/dynamic imports,
real paths, runtime module cycles and the `web/client` browser boundary. Computed
or unresolved dependencies and custom loaders are errors. Declaration-level
type-only imports retain their boundary checks without introducing runtime cycle
edges. The README documents the exact import matrix and the limits of static
analysis; no metadata classes or configuration switches were introduced.

Removed `BoringApi.scan()` and the special prototype-folder migration branches.
The ordinary URL-directory validation still rejects invalid folder names in both
startup and check. Permission-based authorization and its custom hook contract
remain intact.

Validation: `yarn example:check`, `yarn typecheck`, `yarn test` (48 passing tests)
and `yarn build` all passed.

## 3. Make existing functionality discoverable

Status: complete (2026-09-19).

- Add `boring inspect` with readable output and a stable JSON format.
- Derive endpoints, public operations, input/output types, implementation
  locations, authorization rules and inherited hooks from the source.
- Reuse a common static model where discovery, checks and inspection overlap.
- Avoid a second, manually maintained service registry or function catalog.
- Extend consumer agent instructions: inspect existing capabilities, extend an
  existing module where appropriate, then run the checks.

Acceptance: an agent can locate the existing order operation and understand a
route's effective hooks without reading unrelated files or executing application
setup. Export signatures and locations stay current after code changes.

Delivered: `boring inspect [api-directory] [--json]` and the repository's
`yarn example:inspect` script. The version 1 catalog reports routes, callable
services, all public module exports, Zod input/output types, overloads/generics,
source locations, access declarations and effective inherited hooks. It follows
aliases, re-exports and CommonJS exports without executing application code.
Computed access rules remain explicit expressions instead of guessed values.

Startup, type generation and inspection share the structural scanner and error
hook precedence. Check and inspect share project analysis and mandatory validation;
architecture diagnostics and inspection infer services from the same symbols.
The README documents the JSON contract and static limits. Consumer instructions
now start with inspection before extending existing modules. Factories and file
conventions provide the needed metadata; no base classes or registration API are needed.

Validation: `yarn example:check`, `yarn typecheck`, `yarn test` (60 passing tests)
and `yarn build` all passed. Tests cover non-execution, current signatures,
CommonJS exports, effective hooks, CLI diagnostics/JSON, structural parity and
HTTP behavior after consolidating discovery.

The follow-up audit identified four catalog errors, now fixed with regression
tests: type-only re-export chains retain their type-only status; composed and
union services expose their available methods; private/protected methods stay
out of the operation catalog and repair hints; generic constraints/defaults are
instantiated while preserving dependencies between method type parameters.

## Module shortcuts and consumer builds (after step 3, before step 4)

Status: complete (2026-09-19).

- Add `$modules/<name>/schemas` and `$modules/<name>/facade`, resolved from the
  explicitly selected API directory's sibling `modules` tree.
- Generate the TypeScript `paths`, `baseUrl` and `rootDirs` configuration for
  ordinary IDE completion, hover, definitions, rename and auto-imports. Diagnose
  conflicting consumer mappings with `BORING108`; no language server is needed.
- Reuse TypeScript resolution in static checks/inspection and the import
  transformer. Module boundaries remain mandatory, including aliased access.
- Add `boring build` for consumer CommonJS output with rewritten imports,
  declarations and source maps. Validate before replacing owned output and
  remove stale routes on a successful rebuild.
- Share the transformation with `boring dev` and expose
  `@boringapi/core/register` for custom source servers and test runners.
- Update the example and documentation; preserve short same-module imports.

Acceptance: language-service tests exercise the actual generated configuration;
source execution, multiple applications and compiled HTTP requests use the same
shortcut. Declaration output resolves without source, failed builds preserve
existing output, and the repository checks pass.

Delivered: shared import transformation, generated IDE configuration, the
consumer build command, the public source-compiler registration and an updated
example. The TypeScript 4.9 language-service tests cover path/member completion,
hover, definitions, rename and shortcut auto-imports. Source and build tests
cover re-exports, import types, import-equals, dynamic imports and literal
CommonJS calls, including shadowed loader names and independent applications.

Validation: `yarn example:check`, `yarn typecheck`, `yarn test` (66 passing tests),
`yarn build` and `yarn example:build` passed. A packed-package consumer exercised
the executable CLI, sync, check, inspect, source registration, dev and build, then
started the production API after removing its original source directory. A
regression test also confirms that dev chooses the same project configuration
as check/build when another tsconfig is nested beside the API. Generators are tracked in step 4.

The follow-up audit identified four edge cases, now fixed with regression tests:
source execution loads JavaScript companions of declaration files; default-output
rebuilds exclude previous output from the source search; nested import types are
rewritten in emitted and copied declarations; emitted paths follow the configured
JSX mode. `yarn example:check`, `yarn typecheck`, `yarn test` (70 passing tests) and
`yarn build` all passed after these corrections.

Application-specific `./$types` now cover setup, authentication, authorization,
middleware, envelopes and error hooks, including directories without routes.
Request hooks retain the complete Context API with inferred services, sessions
and locals appropriate to their execution phase. Envelopes infer validated input
and payloads from their effective routes; errors account for incomplete
authentication, validation and middleware. The example imports these generated
types throughout and no longer casts its session for authorization.

Validation: `yarn example:check`, `yarn typecheck`, `yarn test` (76 passing tests)
and both `yarn build` and `yarn example:build` passed. New tests check ordinary TypeScript IntelliSense and
definition navigation, return-type changes, hook-only directories, partial and
overwritten locals, effective envelopes, and hook declarations in source-free
consumer builds.

## 4. Generate the established patterns

Status: implemented and validated.

- Add `boring init`, `boring add module <name>` and
  `boring add endpoint <path/method>`.
- Generate the established structure, consumer instructions and check scripts.
- Use the generated `./$types` in route and hook templates.
- Include the `$modules` editor configuration and `boring build` scripts.
- Inspect existing modules before creating new code; reuse an existing module
  and its schemas rather than generating competing services or copied types.
- Never overwrite existing work silently. Keep output small and directly editable.
- Include the development loop for code outside the API directory.

Acceptance: adding another order endpoint reuses the existing orders module;
generated code passes the same checks as handwritten code.

Delivered: `boring init [project-directory] [--dir api]`, `boring add module <name>`
and `boring add endpoint <path/method>`, with `--dir`/`--project` for an existing
consumer and `--from` for explicit adapter reuse. The starter includes a shared
health facade/schema, typed setup and handler, infrastructure boundary, editor
configuration, package scripts, consumer instructions and a runnable HTTP test.

Generators inspect existing modules and operations first. A unique compatible
adapter is reused with its schemas, permissions and service calls; ambiguous
matches require explicit selection. Different inherited hooks or URL parameter
names prevent reuse. New adapters without a template return 501 until implemented;
new module factories remain small and receive explicit setup wiring after their
business operations are implemented. Source collisions and unsafe paths are
rejected, and failed post-generation checks roll back new source.

Validation: `yarn example:check`, `yarn typecheck`, `yarn test` (90 passing tests),
`yarn build` and `yarn example:build` passed, including the parallel `boring start`
changes. Nine generator tests cover initialized consumers, module and adapter
reuse, schema imports, permission and hook preservation, ambiguity, unsafe paths,
collision handling, rollback, the compiled CLI and the generated HTTP test.
The package dry run includes the compiled generators and excludes source,
examples and repository tests.

## 5. Provide complete database and web application paths

Status: implemented and validated. The reference uses PostgreSQL
with `pg`, a React/Vite SPA and HTML pages through ordinary Boring API routes.

- Choose and document one standard database integration per application, with a
  single schema/migration location and transactions owned by business operations.
- For an SPA, derive a client from API contracts and provide one standard request
  and error-handling path. Share browser-safe contracts, never server code.
- For an MPA, reuse the same facades from server-rendered pages; authorization
  must remain effective outside HTTP API handlers.
- Introduce external integrations through the infrastructure boundary so existing
  modules can reuse them.
- Keep extensions at explicit boundaries, without building a general-purpose
  dependency-injection container or a large configuration surface.

Acceptance: documented end-to-end examples use the chosen integration consistently
and retain the same business operations across their API and web entry points.

Delivered in `examples/fullstack`: a single migration history with checksums and
database locking, a parameterized PostgreSQL adapter, business-owned transactions
covering orders and audit events, shared permission-checked facades and schemas,
a React SPA and server-rendered order pages. Setup injects the same orders facade
into both adapters. Explicit migration, check, development and build scripts make
the complete reference runnable.

The browser-safe `@boringapi/core/client` entry point provides typed requests,
query/path encoding, cancellation and HTTP errors without server dependencies.
When `web/client` exists, source analysis generates standalone `$client` contracts
from route schemas and effective envelopes. Generated declarations do not import
application modules. `web/server` is included in mandatory architecture analysis;
`BORING109` rejects storage/SDK imports and reverse dependencies on presentation.
Client regression coverage also exercises real HTTP and generated compiler
contracts for nonempty bracket-encoded query arrays, conditional/imperative
envelopes, JSON array/tuple null conversion, omitted object fields, empty null
responses and content-type-aware text/JSON decoding. Empty query arrays fail
explicitly before fetching; optional fields can be omitted instead.
Additional compiler and HTTP regressions cover handlers that finish with 204
before an inherited envelope, imperative payload writes, and synchronous/asynchronous
envelope overloads. Without an output schema or a single envelope call signature,
client output stays unknown; explicit output schemas and envelope opt-outs retain
their concrete contracts.

Validation: `yarn example:check`, `yarn typecheck`, `yarn test` (106 passing tests,
none skipped), `yarn build`,
`yarn example:build`, `yarn example:fullstack:check` and
`yarn example:fullstack:build` passed after the envelope audit fixes. The complete
suite passed with the standard test command and unchanged timeouts.
The PostgreSQL integration ran against
an isolated PostgreSQL 17 instance and covers migration locking/checksums,
persistence, atomic rollback, shared API/page results, validation and permissions.
The compiled combined server also passed a separate migration, SPA asset, client,
API and HTML-page smoke test. Browser declarations resolve with TypeScript 4.9
without server imports; the package dry run includes the browser subpath and
excludes example/source/test files. Temporary servers and database were stopped.
