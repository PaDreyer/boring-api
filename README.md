# Boring API

Predictable backend architecture for applications built with coding agents.

Boring API gives application responsibilities named places, makes existing
operations discoverable and rejects forbidden dependencies with static checks.
Its goal is to keep a backend consistent as people and agents repeatedly extend it.
It uses TypeScript, Express 4 and Zod 3.

- **Checked roles:** facades coordinate use cases, services use injected ports, and infrastructure implements them. Same-module imports and setup exposure follow the [role contract](docs/architecture.md).
- **Enforced boundaries:** mandatory checks reject imports that bypass the supported application boundaries, including unused source and aliases.
- **Discover before extending:** inspect existing operations, schemas and entry points; generators reuse the same checked application model.
- **Owned lifecycle:** validated configuration, managed cleanup, isolated execution contexts and shared HTTP/non-HTTP operations. [Lifecycle contract](docs/lifecycle.md).
- **Reliable publication:** transactional PostgreSQL event intents, a fenced publisher and durable deduplicating consumers make commit-to-delivery recovery explicit. [Publication contract](docs/publications.md).
- **Operational boundaries:** structured logs, correlated spans, bounded metrics and lifecycle-aware health/readiness share one adapter contract. [Operational contract](docs/operations.md).
- **Typed HTTP conventions:** filesystem routes and named hooks describe requests, validation, identity and responses.

Today the framework provides an HTTP runtime, module import checks, web integration
patterns, a common execution lifecycle, durable PostgreSQL jobs and development/build
tooling, including schedules, durable event consumers, application commands,
transactional event publication and operational signals.
The [project vision](docs/vision.md) is the design brief;
the [roadmap](docs/roadmap.md) records current enforcement gaps and delivery milestones.

Working with an agent? Start with the [Agent guide](docs/agent-guide.md).

## Quick start

Requires Node.js 18 or newer.

```bash
npm exec --package=@boringapi/cli -- boring init my-api
cd my-api
npm install
npm run sync
npm run dev
```

Open <http://localhost:4040/health> to receive `{"status":"ok"}`. The generated project includes a typed health module, setup hook, HTTP test and project `AGENTS.md`.

To add Boring API to an existing project:

```bash
npm install @boringapi/core zod
npm install --save-dev @boringapi/cli
```

`@boringapi/core` is the runtime; `@boringapi/cli` runs the independently packaged
[development tools](docs/packages.md).
The compiled API starts with Node and needs neither the CLI nor TypeScript.
Use `npx boring` or package scripts to run the CLI. See [configuration and custom servers](docs/cli.md) for manual integration.

## How it works

```text
api/
├── +config.ts           load and validate application configuration
├── +setup.ts            construct dependencies and register cleanup
├── +auth.ts             authenticate and authorize requests
└── orders/
    ├── post.ts          POST /orders
    └── [id]/get.ts      GET /orders/:id
modules/orders/
├── facade.ts            public operations and orchestration
├── service.ts           private business rules
├── ports/storage.ts     type-only storage port when needed
└── schemas.ts           shared Zod contracts
infra/                   storage and external adapters
```

Routes select schemas and call the facade registered by `+setup.ts`:

```ts
// api/health/get.ts — included in the generated project
import { health } from "$modules/health/schemas";
import type { GetHandler } from "./$types";

export const output = health;
export const handler: GetHandler = ctx => ctx.services.health.get(ctx.execution);
```

`$modules` and `$infra` resolve beside the selected API directory. `./$types` is generated from your application. The [Agent guide](docs/agent-guide.md#a-complete-small-feature) shows the schema, service, facade and setup behind this route.

Add `+middleware.ts`, `+envelope.ts` or `+error.ts` where shared behavior belongs. Middleware runs from root to leaf; the nearest envelope or error template applies. Input is validated before the handler and output before the envelope. See [hooks and request flow](docs/reference.md).

## Commands

The generated project provides these scripts:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Watch source and restart the API. |
| `npm run inspect` | Find existing routes, operations, schemas and hooks. Add `-- --json` for structured output. |
| `npm run sync` | Refresh generated types and editor configuration after checkout. |
| `npm run check` | Check types, conventions and mandatory import boundaries. |
| `npm test` | Build and run the generated HTTP tests. |
| `npm run build` | Check and compile the application, rewriting convention aliases. |
| `npm start` | Run the last successful API build. |

Extend an existing module first. For a new domain or route, use `npx boring add module <name>` or `npx boring add endpoint '<path/method>'`. New endpoint stubs return 501 until implemented; compatible existing adapters can be reused.

Source commands default to `api/`; pass `--dir src/api` for another location. See the [CLI reference](docs/cli.md) for generators, build output, deployment and custom TypeScript configurations.

## Documentation

All guides below are included in the npm package.

- [Project vision](docs/vision.md) and [delivery roadmap](docs/roadmap.md) — the backend architecture we are building and what remains to implement.
- [Agent guide](docs/agent-guide.md) — workflow, ownership rules and common decisions.
- [CLI and deployment](docs/cli.md) — scaffolding, aliases, development and production.
- [Routes, modules and permissions](docs/application.md) — application structure and checked boundaries.
- [Application lifecycle](docs/lifecycle.md) — configuration, ownership, controlled execution, cancellation and migration.
- [Durable jobs](docs/jobs.md), [schedules, events and commands](docs/triggers.md), and [reliable publication](docs/publications.md) — shared facades, delivery rules and separate processes.
- [Operational contract](docs/operations.md) — structured records, correlation, metrics, health/readiness and flush ownership.
- [Hooks and generated types](docs/reference.md) — context, validation and request lifecycle.
- [Inspection catalog](docs/inspection.md) — discover existing code and consume the JSON format.
- [Database and web applications](docs/web.md) — transactions, SPA/MPA reuse and the typed browser client.

`boring init` points the project's `AGENTS.md` at the installed Agent guide. To locate it from any consumer project:

```bash
node -p "require.resolve('@boringapi/core/agent-guide')"
```

Runnable examples live in the repository: [basic API](https://github.com/PaDreyer/boring-api/tree/master/examples/basic) and [PostgreSQL + React + server-rendered pages](https://github.com/PaDreyer/boring-api/tree/master/examples/fullstack). They are not included in the npm package.

## Contributing

The repository uses pnpm workspaces: the published packages live in `packages/*`,
and `examples/basic` and `examples/fullstack` are private consumer workspaces.

See the [contributor guide](https://github.com/PaDreyer/boring-api/blob/master/CONTRIBUTING.md) for repository setup, tests and releases. Report bugs through [GitHub Issues](https://github.com/PaDreyer/boring-api/issues).

## License

[MIT](LICENSE)
