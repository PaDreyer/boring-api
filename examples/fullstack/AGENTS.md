# Working on the fullstack reference

The repository AGENTS.md applies. This is one consumer with one PostgreSQL
database, React SPA and server-rendered order pages.

- Inspect with `yarn ts-node src/cli.ts inspect examples/fullstack/api --project
  tsconfig.fullstack.json` before adding functionality. Reuse `orders.create` and
  `orders.get`; do not add another orders service, database pool or request helper.
- Keep the PostgreSQL schema in `infra/db/migrations.ts`. Append migrations;
  never edit applied SQL. Parameterize SQL and validate rows with shared schemas.
  The facade decides what runs inside one transaction, including audit records.
- Setup owns dependency construction. Infrastructure never calls business
  operations. Add external SDKs behind this same boundary, not in routes or pages.
  Import adapters/configuration via `$infra/<path>` and public module entries via
  `$modules/<name>/...`. The migration script preloads `register-source.ts` so its
  own imports use the same source compiler as the API.
- Use `web/client/api.ts` for browser requests, `ApiError` for HTTP failures and
  public schemas for form validation. Import generated `ApiRoutes` with
  `import type { ApiRoutes } from "$client"`;
  never import the server entry point or a facade into browser source.
- Keep presentation under `web/server`. Pages take injected facades and explicit
  actors; they validate inputs and escape HTML. They do not access storage.
- Permissions belong in both route declarations and business operations. The
  environment-controlled bearer-token provider is a demo, not production login.
- Run the fullstack check/build scripts and repository checks. Set
  `BORING_TEST_DATABASE_URL` to an isolated test database to include the real
  PostgreSQL test in `yarn test`; it creates and removes its own random schema.
