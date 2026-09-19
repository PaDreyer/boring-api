# Agent instructions

## Project intent

Boring API maps filesystem conventions to HTTP routes and cross-cutting behavior. A route should be recognizable from its path and named exports without reading router wiring. The current contract is documented in `README.md`; update it whenever a convention changes.

## Where things belong

- `src/core`: discovery, request pipeline, context, shared types and errors.
- `src`: the reusable library only. Do not add application routes or a fixed server here.
- `examples/basic/api`: a separate example consumer. A route is `<URL folders>/<HTTP method>.ts` below the consumer's chosen API directory.
- `+setup.ts` and `+auth.ts`: root-only setup and authentication/authorization.
- `+middleware.ts`: available at any URL folder; inherited from root to leaf.
- `+envelope.ts`, `+error.ts`, `+error.<status>.ts`: available at any URL folder; nearest definition overrides an ancestor.
- `.boring/types`: generated `$types` modules; never edit or commit them. Route files import method-specific handlers such as `GetHandler` from `./$types`.
- `test`: HTTP integration tests and isolated fixtures. Keep helper code outside the scanned endpoint tree.

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
- The prototype's `_base` and `_setup` folders are retired; do not add new behavior through them. Keep migration errors explicit.
- Preserve the public `BoringApi.createApp()` and `BoringApi.listen()` API. `scan()` remains a compatibility alias.
- The published package exposes consumer commands through `package.json#bin` as `boring`. Repository scripts use the `example:*` prefix when they run the bundled example; do not confuse them with commands copied into consumer projects.
- Keep everything needed at runtime or by the public declaration files in `dependencies`. A packed tarball must contain the compiled library, executable CLI, README and license without source or example files.

## Working on the project

Use the existing TypeScript, Express 4 and Zod 3 stack. Prefer a named file convention over decorators, manual router registration or per-route pipeline configuration. When changing routing, generated types or the request pipeline, add a test that catches the behavioral risk. Run `yarn example:check`, `yarn typecheck`, `yarn test`, and `yarn build` before declaring a change complete. Keep README examples aligned with the code. Avoid adding dependencies for routine framework behavior.
