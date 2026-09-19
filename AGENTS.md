# Agent instructions

## Project intent

Boring API maps filesystem conventions to HTTP routes and cross-cutting behavior. A route should be recognizable from its path and named exports without reading router wiring. The package entry point is `README.md`; detailed contracts live in `docs/`. Update the relevant reference and `docs/agent-guide.md` whenever a convention or recommended workflow changes. Keep the README concise and generated consumer `AGENTS.md` focused on project context plus a pointer to the installed guide. Contributor setup and release instructions belong in `CONTRIBUTING.md`.

## Where things belong

- `packages/core/src/core`: discovery, request pipeline, context, shared types and errors.
- `packages/core/src`: the reusable library only. Do not add application routes or a fixed server here.
- `examples/basic/api`: a separate example consumer. A route is `<URL folders>/<HTTP method>.ts` below the consumer's chosen API directory.
- Consumer `modules/<name>/facade.ts` and `schemas.ts` are public entry points; other module files are private. Sibling `infra/` holds adapters, `web/client/` marks browser source, and `web/server/` holds server presentation adapters wired by setup.
- Use `$modules/<name>/...` and `$infra/<path>` for imports across those directories where architecture rules permit them. Both aliases follow the selected API's sibling directories through editor, source compiler and build resolution; same-module imports can stay relative.
- `+setup.ts` and `+auth.ts`: root-only setup and authentication/authorization.
- `+middleware.ts`: available at any URL folder; inherited from root to leaf.
- `+envelope.ts`, `+error.ts`, `+error.<status>.ts`: available at any URL folder; nearest definition overrides an ancestor.
- `.boring/types`: generated `$types` modules; never edit or commit them. Route files import method-specific handlers such as `GetHandler` from `./$types`.
- `packages/core/test`: HTTP integration tests and isolated fixtures. Keep helper code outside the scanned endpoint tree.

- The root is a private pnpm workspace; reusable packages live in `packages/*`, private consumers in `examples/*`. Keep each workspace's dependencies and tests local. Use `workspace:^` and public package imports across workspace boundaries. The CLI remains in Core until explicitly extracted.
- Each example owns its `tsconfig.json`, `.boring/` and `dist/`; do not add root source aliases into library code. Root documentation is copied into Core during build/pack; edit only the root originals.

## Invariants

- A `Context` belongs to exactly one request. Never put request state on the Express app, a setup context, or module globals.
- The consumer explicitly passes its API directory to `BoringApi.createApp(directory)` or `listen(directory, port)`. The library must not depend on `process.cwd()` or a bundled `src/endpoints` directory.
- Type generation accepts only API directories inside the consumer project. Resolve real paths and verify containment before deleting or writing generated files.
- Await hooks and handlers before validating, wrapping or sending their result. Send exactly one response.
- Prefer returning a payload from route handlers. Use `ctx.send()` only for an intentional early response because it bypasses output validation and the envelope.
- Use the same request context through authentication, middleware, the route handler and error handling. Apply middleware from root to leaf; choose the nearest envelope and error template.
- Return a service object from `+setup`, a session from `authenticate`, and a locals object from middleware so type generation can expose `ctx.services`, `ctx.session`, and `ctx.locals`. Preserve support for imperative Map writes as an untyped escape hatch.
- Apply input schemas before the handler and the output schema before the envelope. Input failures are 400; output failures are 500.
- A route declaring `authentication` or `authorization` requires a session. Authorization denial should throw `HttpError(403, "Forbidden")`; unexpected errors should remain server errors.
- Prefer typed permission rules in consumers: a permission string, non-empty `allOf`, or non-empty `anyOf`. Roles explicitly bundle permissions; business operations enforce them too. Keep the library's custom `authorize(ctx, rule)` contract compatible.
- A nearest `+envelope.ts` wraps every successful payload by default. A route can set `envelope = false` to opt out. Empty 204 responses have no envelope.
- Do not embed passwords, tokens, or fake production integrations in examples. The example bearer-token hook is demonstration code controlled by `BORING_API_TOKEN`.
- Reject ambiguous routes and invalid convention files at startup rather than silently ignoring them.
- `boring check` must reject the same structural convention mistakes as startup and validate route and hook export contracts without executing application modules.
- `boring inspect` uses the same static model and mandatory checks. Derive its versioned JSON catalog from source without executing application modules or maintaining a separate service registry.
- Generators inspect existing capabilities before adding source and validate their results without executing application code. Never overwrite existing source, invent business permissions, or silently move an adapter across different inherited hooks. Use `$modules` and generated `./$types` in templates.
- Browser code uses `@boringapi/core/client` and `import type { ApiRoutes } from "$client"`. The fixed alias resolves to the selected API's generated contract through the generated editor configuration. Generated client contracts must remain standalone without server imports. Server pages reuse injected facades and never import database adapters or SDKs.
- Client wire contracts account for JSON omission/null conversion and Express empty responses. Query arrays use bracket keys and must be nonempty; reject empty arrays before fetching instead of treating them as omission. Envelopes that can return undefined have conservative client output types because they can retain or mutate the payload. Derive concrete envelope types only with an output schema and a single call signature; otherwise keep the response unknown.
- The fullstack reference uses PostgreSQL via `pg`, one migration list in `infra/db/migrations.ts`, and transactions owned by business operations. Keep SQL parameterized and validate database results with shared schemas. Migrations run explicitly, never on ordinary requests.
- Use the public `BoringApi.createApp()` and `BoringApi.listen()` API. Do not add legacy aliases or compatibility modes.
- Architecture checks are mandatory in `boring check`; do not add switches to disable them.
- Keep architecture analysis static, including unused source, aliases, re-exports and literal CommonJS imports. Diagnose unsupported dynamic loading instead of silently skipping it. Use stable `BORING` diagnostic codes with source locations.
- The published package exposes consumer commands through `package.json#bin` as `boring`. Repository scripts use the `example:*` prefix when they run the bundled example; do not confuse them with commands copied into consumer projects.
- Keep everything needed at runtime or by the public declaration files in `dependencies`. A packed tarball must contain the compiled library, executable CLI, README, consumer documentation in `docs`, and license without source or example files. Keep the `@boringapi/core/agent-guide` locator working; verify the actual tarball with `scripts/check-package.js`.

## Working on the project

Use the existing TypeScript, Express 4 and Zod 3 stack. Prefer a named file convention over decorators, manual router registration or per-route pipeline configuration. When changing routing, generated types or the request pipeline, add a test that catches the behavioral risk. Build Core first with `pnpm build`, then run `pnpm example:check`, `pnpm typecheck`, `pnpm test`, and both `pnpm example:build` and `pnpm example:fullstack:build` before declaring a change complete. Keep README examples aligned with the code. Avoid adding dependencies for routine framework behavior.
