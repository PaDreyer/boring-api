# Hooks, generated types and request flow

[Package README](../README.md) · [Agent guide](agent-guide.md)

Route and hook types are inferred from the application’s own schemas and return values. See the [route export reference](application.md#adding-a-route) for method files.

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
[basic authentication example](https://github.com/PaDreyer/boring-api/blob/master/examples/basic/api/+auth.ts) uses `AuthenticationContext` for credential
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
    "paths": {
      "$modules/*": ["modules/*"],
      "$infra/*": ["infra/*"],
      "$client": [".boring/types/api/$client.d.ts"]
    }
  }
}
```

For `src/api`, use `src/modules/*`, `src/infra/*` and `.boring/types/src/api/$client.d.ts`.
Merge these mappings with any other explicit
`paths` entries. The generated configuration is refreshed by `sync`, `dev`,
`check`, `inspect` and `build`. Checks set `rootDirs` themselves; convention alias
imports additionally require matching editor settings as described in the [alias configuration reference](cli.md#module-shortcuts-editor-support-and-builds).
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

Safe defaults apply when convention files are absent: no session, HTTP 401 for protected routes without a session, HTTP 403 for an authorization rule without `authorize()`, unchanged successful responses, and JSON error responses without internal server details. A default logger is provided. `+auth.ts` and `+setup.ts` replace or extend this behavior as needed. The [basic authentication example](https://github.com/PaDreyer/boring-api/blob/master/examples/basic/api/+auth.ts) uses an environment token for demonstration purposes only.

## Context and request flow

Every request receives its own `Context`. `ctx.request` and `ctx.response` are the Express objects. `ctx.params`, `ctx.query`, and `ctx.body` contain validated input. `ctx.services`, `ctx.session`, and `ctx.locals` are inferred from convention files. The `get()` and `set()` map methods remain available for dynamic edge cases; return values are the standard typed approach. Request data does not belong in global variables or the setup context.

Each route runs through: authentication → inherited middleware → session check → authorization → input validation → handler → output validation → nearest envelope → send. Every step is awaited. If an error occurs, the matching error file receives the same request context.
