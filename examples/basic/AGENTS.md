# Working on the basic example

Read the [shared Agent guide](../../docs/agent-guide.md) before changing this
application. The repository [AGENTS.md](../../AGENTS.md) also applies. This private workspace
uses the public exports of the local Core package; standalone consumers locate the same guide
through `@boringapi/core/agent-guide` in their installed package.

- Inspect with `pnpm example:inspect` (`--json` for structured output), from the
  repository root. The API is `examples/basic/api`; its sibling directories hold
  the modules and infrastructure.
- Reuse the orders facade's `create` and `get` operations, shared schemas and
  injected store. `modules/access/schemas.ts` owns permissions;
  `modules/access/facade.ts` owns explicit role grants and `requireAccess`.
  Enforce access in both route declarations and business operations.
- The `BORING_API_TOKEN` hook and memory store are demonstration code. Keep
  credentials in the environment and request state out of shared services.
- Use `$modules` and `$infra` where allowed. This example owns its tsconfig,
  generated `.boring/` directory and build output.
- For generators, run `pnpm --filter @boringapi/example-basic exec boring add
  module <name>` or `pnpm --filter @boringapi/example-basic exec boring add
  endpoint '<path/method>'`. Extend an existing domain first; review generated
  adapters and their inherited hooks/access rules.
- Build all packages first with `pnpm build`, then run `pnpm example:check`,
  `pnpm typecheck`, `pnpm test` and `pnpm example:build`. Start the compiled
  server with `pnpm example:start`.

See the [example README](README.md) for HTTP requests and the
[fullstack example](../fullstack/README.md) for persistent storage and web interfaces.
