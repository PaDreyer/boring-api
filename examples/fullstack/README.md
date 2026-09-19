# PostgreSQL, React and server-rendered orders

This application demonstrates one business module used by a JSON API, React SPA
and HTML page. It uses PostgreSQL through `pg`; the core framework remains
independent of that driver. Run the commands below from the repository root.

## Run

Use Node 22.12+ for the Vite tooling and install with `yarn install`. Configure
`DATABASE_URL` for a database you own and `BORING_API_TOKEN` for the demo bearer
provider through your local environment. No credentials are included here.
The repository pins the PostgreSQL declaration package and its declaration-only
protocol dependency for TypeScript 4.9. The runtime driver uses its current
protocol dependency; no runtime downgrade is required.

```bash
yarn example:fullstack:sync
yarn example:fullstack:check
yarn example:fullstack:migrate
yarn example:fullstack:dev
```

In another terminal run `yarn example:fullstack:web`, open
http://localhost:5173 and enter your configured demo token. The SPA creates an
order and reads it back with the generated client. It keeps the token only in
component memory. The Vite proxy forwards `/orders` and `/pages` to port 4041.

```bash
curl -H "Authorization: Bearer $BORING_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"item":"Notebook","quantity":2}' http://localhost:4041/orders

# Substitute the returned UUID for ORDER_ID:
curl -H "Authorization: Bearer $BORING_API_TOKEN" http://localhost:4041/orders/ORDER_ID
curl -H "Authorization: Bearer $BORING_API_TOKEN" http://localhost:4041/pages/orders/ORDER_ID
```

The second URL returns a complete HTML page. It calls the same orders facade;
there is no server-to-server HTTP call and no duplicate query. Requests to both
surfaces require the same bearer identity. This example does not provide a
browser login or cookie session; use your authentication provider/proxy for that.

## Build and deploy

```bash
yarn build
yarn example:fullstack:build
yarn example:fullstack:start
```

The combined server serves the SPA at http://localhost:4041 and the API/MPA at
their existing paths. `PORT` changes this port; `WEB_DIST` can select relocated
static assets. Keep the compiled server output and generated static assets
together. Apply migrations explicitly before starting, including in deployment.
The build contains the SQL migration list, so migrations can also run with
`node .boring/fullstack-build/examples/fullstack/migrate.js` after compilation.
`boring start` starts only the API; use this example's server for combined static
hosting. The sample has no client-side URL router or HTML fallback hiding API 404s.

For a standalone consumer, put `@boringapi/core`, `zod`, `pg`, `react` and
`react-dom` in dependencies, and Vite plus the corresponding `@types` packages
in devDependencies. Use package imports instead of this repository's relative
library imports. Extend `.boring/tsconfig.json`, enable `jsx: "react-jsx"`, and
map Vite's `$modules` alias to this application's modules directory. The browser
subpath resolves directly from the installed package, so its repository-specific
Vite alias is unnecessary.

## Storage and boundaries

- `infra/db/migrations.ts` is the sole database schema history. Append ordered
  migrations. The runner checks applied checksums and runs pending SQL inside
  a transaction guarded by a database lock. It never runs on normal requests.
- `infra/db/database.ts` owns the pool and parameterized SQL. It exposes a narrow
  typed order store and validates row shapes with the public Zod schema.
- `modules/orders/facade.ts` checks permissions and input, then chooses the atomic
  transaction: order and audit event succeed or fail together. Actor identity is
  passed per call and never retained in the shared facade.
- Setup builds one orders facade, then injects it into the page renderer. HTTP
  routes use the same instance through `ctx.services`. Page rendering escapes
  untrusted strings; shared schemas remain safe for browser imports.
- Browser code has one request helper and one `ApiError` handling path. API
  contract changes are reflected when sync/check/dev/build regenerates `$client`.

## Tests

The normal suite checks the client, generated types, page import boundaries and
permissions without a database. To also run the real PostgreSQL integration test,
set `BORING_TEST_DATABASE_URL` to an isolated database and run `yarn test`. The test
creates and removes a random schema, never the application's existing tables.
It covers migration locking/checksums, persistence after reopening connections,
transaction rollback, API/MPA reads, HTML escaping, validation and authentication.

Example local test instance (temporary, bound to localhost, no stored password):

```bash
docker run --rm -d --name boring-api-tests \
  -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:55432:5432 postgres:17-alpine
# Wait until: docker exec boring-api-tests pg_isready -U postgres
BORING_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/postgres yarn test
docker stop boring-api-tests
```

This trust-authenticated database is only for local tests. Use normal database
authentication for the running application.
