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
remain the next step, not an already enforced guarantee.

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
and `yarn build` all passed. Step 2 remains planned.

## 2. Enforce architecture boundaries with `boring check`

Status: planned.

- Reject database and external SDK imports from endpoints.
- Reject access to another module's internals; expose business operations through
  `facade.ts` and data contracts through `schemas.ts`.
- Reject module dependency cycles and infrastructure imports of endpoints.
- When a browser application is present, reject server imports from browser code.
- Resolve aliases and re-exports using TypeScript's module and symbol information;
  define how dynamic imports and other unanalyzable dependencies are handled.
- Give diagnostics stable codes, source positions, the broken rule and a useful
  repair direction. Include existing public operations when relevant.
- Make the rules the standard for new applications, with an explicit migration
  path for existing embedded consumers. Avoid a large configurable rule system.
- Preserve parity between startup and check for structural API conventions.

Acceptance: fixtures demonstrate forbidden direct DB imports and cross-module
internal imports, including aliases/re-exports; legitimate facade and schema use
passes. Checks do not execute application modules. Structural checks cannot
promise to detect semantically duplicate business functions.

## 3. Make existing functionality discoverable

Status: planned. `boring inspect` does not exist yet.

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

## 4. Generate the established patterns

Status: planned. These generator commands do not exist yet.

- Add `boring init`, `boring add module <name>` and
  `boring add endpoint <path/method>`.
- Generate the established structure, consumer instructions and check scripts.
- Inspect existing modules before creating new code; reuse an existing module
  and its schemas rather than generating competing services or copied types.
- Never overwrite existing work silently. Keep output small and directly editable.
- Include the development loop for code outside the API directory.

Acceptance: adding another order endpoint reuses the existing orders module;
generated code passes the same checks as handwritten code.

## 5. Provide complete database and web application paths

Status: planned. Specific technologies have not been selected.

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
