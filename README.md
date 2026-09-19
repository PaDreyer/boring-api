# Boring API

A convention-driven API framework for TypeScript, Express 4 and Zod 3. Folders define URL paths, method files handle requests, and named hooks provide shared behavior. No router registration or decorators.

- **Routes from files:** `api/orders/[id]/get.ts` handles `GET /orders/:id`.
- **Inferred types:** schemas and hook return values type inputs, services, sessions and responses.
- **Shared business operations:** facades serve API routes, jobs and server-rendered pages.
- **Enforced boundaries:** static checks keep storage, business logic and presentation in their intended places.
- **Built-in tooling:** scaffold, inspect, watch, check and build from one CLI.

Working with an agent? Start with the [Agent guide](docs/agent-guide.md).

## Quick start

Requires Node.js 18 or newer.

```bash
npm exec --package=@boringapi/core -- boring init my-api
cd my-api
npm install
npm run sync
npm run dev
```

Open <http://localhost:4040/health> to receive `{"status":"ok"}`. The generated project includes a typed health module, setup hook, HTTP test and project `AGENTS.md`.

To add Boring API to an existing project:

```bash
npm install @boringapi/core zod
```

Use `npx boring` or package scripts to run the CLI. See [configuration and custom servers](docs/cli.md) for manual integration.

## How it works

```text
api/
├── +setup.ts            construct dependencies and expose facades
├── +auth.ts             authenticate and authorize requests
└── orders/
    ├── post.ts          POST /orders
    └── [id]/get.ts      GET /orders/:id
modules/orders/
├── facade.ts            public business operations
└── schemas.ts           shared Zod contracts
infra/                   database and external adapters
```

Routes select schemas and call the facade registered by `+setup.ts`:

```ts
// api/health/get.ts — included in the generated project
import { health } from "$modules/health/schemas";
import type { GetHandler } from "./$types";

export const output = health;
export const handler: GetHandler = ctx => ctx.services.health.get();
```

`$modules` and `$infra` resolve beside the selected API directory. `./$types` is generated from your application. The [Agent guide](docs/agent-guide.md#a-complete-small-feature) shows the schema, facade and setup behind this route.

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

- [Agent guide](docs/agent-guide.md) — workflow, ownership rules and common decisions.
- [CLI and deployment](docs/cli.md) — scaffolding, aliases, development and production.
- [Routes, modules and permissions](docs/application.md) — application structure and checked boundaries.
- [Hooks and generated types](docs/reference.md) — context, validation and request lifecycle.
- [Inspection catalog](docs/inspection.md) — discover existing code and consume the JSON format.
- [Database and web applications](docs/web.md) — transactions, SPA/MPA reuse and the typed browser client.

`boring init` points the project's `AGENTS.md` at the installed Agent guide. To locate it from any consumer project:

```bash
node -p "require.resolve('@boringapi/core/agent-guide')"
```

Runnable examples live in the repository: [basic API](https://github.com/PaDreyer/boring-api/tree/master/examples/basic) and [PostgreSQL + React + server-rendered pages](https://github.com/PaDreyer/boring-api/tree/master/examples/fullstack). They are not included in the npm package.

## Contributing

The repository uses pnpm workspaces: the published package lives in `packages/core`,
and `examples/basic` and `examples/fullstack` are private consumer workspaces.

See the [contributor guide](https://github.com/PaDreyer/boring-api/blob/master/CONTRIBUTING.md) for repository setup, tests and releases. Report bugs through [GitHub Issues](https://github.com/PaDreyer/boring-api/issues).

## License

[MIT](LICENSE)
