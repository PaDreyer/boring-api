# Database, SPA and server-rendered pages

[Package README](../README.md) · [Agent guide](agent-guide.md)

Keep storage behind injected facades and reuse those operations from every presentation surface.

## Database and presentation ownership

The [fullstack reference](https://github.com/PaDreyer/boring-api/tree/master/examples/fullstack) uses PostgreSQL with `pg`, a React SPA
with Vite, and HTML pages served through ordinary Boring API routes. The library
does not install a database driver or UI framework into every application.

```text
api/+setup.ts                         initialize adapters and wire facades/pages
api/orders/post.ts                    create through the orders facade
api/orders/[id]/get.ts                read through the same facade
api/pages/orders/[id]/get.ts          return rendered HTML, envelope = false
modules/orders/facade.ts             operations, permissions, transactions
modules/orders/schemas.ts            shared Zod contracts
infra/db/database.ts                 one PostgreSQL connection pool and adapter
infra/db/migrations.ts               the database schema's migration history
web/client/api.ts                    one typed API client
web/client/main.tsx                  React SPA
web/server/pages.ts                  HTML rendering using the injected facade
```

The orders facade owns its transaction: order and audit event either both commit
or both roll back. The adapter uses one checked-out connection for the whole
transaction, parameterized SQL and Zod validation of returned rows. This follows
the [node-postgres transaction contract](https://node-postgres.com/features/transactions).
Migration SQL lives in one append-only list; a database lock serializes migration
runs, and stored checksums reject edits to already applied migrations. Run
migrations explicitly before starting an application. External SDKs follow the
same infrastructure boundary: initialize them in setup and inject their narrow
interfaces into the existing business module.

The SPA reuses the public schemas for form validation and makes all requests
through one `createClient` instance. The MPA page calls the same `orders.get`
operation directly. It validates input, passes an explicit actor and escapes
HTML. Facade permission checks still apply when the caller is outside HTTP.
The page's route uses the ordinary authentication/error pipeline, returns HTML
with `ctx.response.type("html")`, and declares `envelope = false`.

See the [fullstack example’s setup and deployment instructions](https://github.com/PaDreyer/boring-api/blob/master/examples/fullstack/README.md)
for the runnable application, including database configuration, frontend tooling,
source migration bootstrap and integration tests. Example source is available in
the repository; it is not included in the npm package.

For a consumer, include browser source in TypeScript checking and configure your
browser bundler to resolve `$modules` to the sibling modules directory. `$client`
is type-only and needs no runtime bundler alias. Boring API’s build compiles the
server; use your frontend build tool for browser assets. `node dist/boring-start.cjs`
starts the compiled API without development tools. For combined static hosting, use a custom server with `BoringApi.createApp()`
as described in the [CLI reference](cli.md#integrating-with-an-existing-server).

## Generated browser contracts

When a sibling `web/client` directory exists, `boring sync`, `check`, `inspect`,
`dev` and `build` also generate a virtual `$client.d.ts` at the API root. Like
`$types`, it is stored under `.boring/types` and is never edited or committed.
The fixed `$client` shortcut resolves to that contract from any source directory.
Use the consumer's generated editor configuration so the import resolves:

```ts
// web/client/api.ts
import { createClient } from "@boringapi/core/client";
import type { ApiRoutes } from "$client";

export const api = createClient<ApiRoutes>("/api"); // mount prefix, or ""
const created = await api.request("POST /orders", {
    body: { item: "Notebook", quantity: 2 },
});
const found = await api.request("GET /orders/:id", { params: { id: created.id } });
```

Endpoint keys come from HTTP methods and filesystem paths. Inputs use the Zod
schema's input types; responses use its output types and the effective envelope's
return type. Contracts contain expanded data types and no server imports.
Unsupported/recursive types, handlers without output schemas and imperative
payload writes may produce `unknown`; use explicit JSON contracts and return
values for useful client types. Types describe declared successful responses;
early `ctx.send()` responses that bypass output validation are not modeled.
Dates in responses become strings. Undefined array and tuple slots in responses
become `null`; undefined object fields are omitted. A top-level `null` payload is
sent by Express as an empty body and becomes `undefined` in the client. JSON input
arrays and tuples exclude `undefined` slots because serialization would change
them to `null`; use `null` explicitly only when the input schema accepts it.
Native Date inputs cannot cross JSON; accept an ISO string and transform it on the
server. An envelope that may return `undefined` produces `unknown`: that branch
keeps the current payload, including any imperative changes made by the hook.
Overloaded envelope handlers also produce `unknown`; a single return contract is
needed for a concrete client type. Without an output schema, the client response
stays `unknown` even with an envelope, because an empty handler can finish with
204 before the envelope runs.

The transport encodes URL parameters, supports flat scalar/nonempty-array query fields,
serializes JSON bodies, preserves response envelopes and returns `undefined` for
HEAD/204. Query arrays use bracket keys (`tag[]=one&tag[]=two`) so Express preserves
single-element arrays, including `[""]`. Empty query arrays have no supported wire
representation: generated contracts reject them and the transport throws before
fetching. For optional filters, explicitly omit the field or pass `undefined`;
`[]` is never silently treated as omission. Query objects do not support nested
values or null/undefined array elements. Responses with a `text/*` content type
return text (including numeric-looking text); JSON responses are decoded as JSON.
Media-type parameters such as `charset=utf-8` are supported.
Client types do not perform runtime response validation. Use public Zod schemas
when the browser needs to validate an external or independently deployed API.

`ApiError` exposes the HTTP `status`, original `payload` and the default error
message when available. Custom error payloads are preserved; network and abort
errors propagate. Pass request options as the third argument for `signal` or
headers. Configure changing authorization through `headers: () => ...` on the
client; credentials default to `same-origin`. The `@boringapi/core/client` entry
point has no Express or Node dependencies and can be bundled independently.
