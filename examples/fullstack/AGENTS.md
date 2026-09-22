# Working on the fullstack reference

Read the [shared Agent guide](../../docs/agent-guide.md) before changing this
application. The repository [AGENTS.md](../../AGENTS.md) also applies. This is one
consumer with one PostgreSQL database, React SPA, server-rendered order pages and a durable worker.
The specifics below supplement the shared workflow.

- Build all packages with `pnpm build`, then inspect with `pnpm example:fullstack:inspect` before adding functionality. Reuse `orders.create` and
  `orders.get`; do not add another orders service, database pool or request helper.
- Keep the PostgreSQL schema in `infra/db/migrations.ts`. Append migrations;
  never edit applied SQL. Parameterize SQL and validate rows with shared schemas.
  The facade selects the transaction boundary; the private orders service writes
  the order and audit event through the storage port in one transaction.
- Root `+config` validates application configuration. Setup owns dependency construction
  and registers the PostgreSQL pool with `ctx.onClose` immediately. Infrastructure never calls business
  operations. Add external SDKs behind this same boundary, not in routes or pages.
  Import adapters/configuration via `$infra/<path>` and public module entries via
  `$modules/<name>/...`. The migration script preloads `register-source.ts` so its
  own imports use the same source compiler as the API.
- Use `web/client/api.ts` for browser requests, `ApiError` for HTTP failures and
  public schemas for form validation. Import generated `ApiRoutes` with
  `import type { ApiRoutes } from "$client"`;
  never import the server entry point or a facade into browser source.
- Keep presentation under `web/server`. Pages take injected facades and the current
  execution context; they validate inputs and escape HTML. They do not access storage.
- Reuse `executions/create-order.ts` for controlled non-HTTP orders. HTTP, pages and
  controlled executions pass the framework-created context to the same facade.
  The application owns listeners and shutdown; call its `close()` to drain work
  before disposing resources.
- Permissions belong in both route declarations and business operations. The
  environment-controlled bearer-token provider is a demo, not production login.
- Jobs in `jobs/orders/create/job.ts` reuse `orders.create`. Queued payloads require requestId; preserve the order/audit/idempotency transaction and explicit worker grants. Run migrations explicitly, then use separate HTTP and worker processes. See the shared job reference.
- New orders also stage `orders.created` through the typed publication port inside
  that same transaction. Preserve the stable event ID, separate publisher process,
  event-ingress deduplication and idempotent `orders.observeCreated` consumer. Do not
  move publication after commit or claim exactly-once/order guarantees. Successful
  outbox pruning is an explicit operator action; see `docs/publications.md`.
- All event declarations share one claim lane and one setup identity. Every scaled
  consumer therefore needs the union of their business grants; do not deploy
  create-only and observe-only consumers against the same queue.
- Setup owns the JSON-Line operational adapter and PostgreSQL readiness probe. Keep
  telemetry non-blocking, labels bounded, health independent of dependencies and
  adapter flush before pool cleanup. The custom server owns `/health/live`,
  `/health/ready` and `/metrics`; see `docs/operations.md`.
- Run the fullstack check/build scripts and repository checks. Set
  `BORING_TEST_DATABASE_URL` to an isolated test database to include the real
  PostgreSQL test in `pnpm test`; it creates and removes its own random schema.

- Schedules, events and commands also call `orders.create`. Preserve requestId from events/commands and use the stable occurrence ID for scheduled orders. Configure their environment grants explicitly; defaults deny. See `docs/triggers.md`.
