# Working on the basic example

Read the [shared Agent guide](../../docs/agent-guide.md) before changing this
application. The repository [AGENTS.md](../../AGENTS.md) also applies. This example
uses the framework source directly; standalone consumers locate the same guide
through `@boringapi/core/agent-guide` in their installed package.

- Inspect with `yarn example:inspect` (`--json` for structured output), from the
  repository root. The API is `examples/basic/api`; its sibling directories hold
  the modules and infrastructure.
- Reuse the orders facade's `create` and `get` operations, shared schemas and
  injected store. `modules/access/schemas.ts` owns permissions;
  `modules/access/facade.ts` owns explicit role grants and `requireAccess`.
  Enforce access in both route declarations and business operations.
- The `BORING_API_TOKEN` hook and memory store are demonstration code. Keep
  credentials in the environment and request state out of shared services.
- Use `$modules` and `$infra` where allowed. The repository tsconfig explicitly
  maps them for this example because tests also generate independent applications.
- For generators, run `yarn ts-node src/cli.ts add module <name> --dir
  examples/basic/api` or `yarn ts-node src/cli.ts add endpoint '<path/method>'
  --dir examples/basic/api`. Extend an existing domain first; review generated
  adapters and their inherited hooks/access rules.
- Run `yarn example:check`, `yarn typecheck`, `yarn test` and `yarn build`.
  `yarn example:build` uses `tsconfig.example.json`; start its compiled server with
  `node .boring/example-build/examples/basic/server.js`.

See the [example README](README.md) for HTTP requests and the
[fullstack example](../fullstack/README.md) for persistent storage and web interfaces.
