# CLI, configuration and deployment

[Package README](../README.md) · [Agent guide](agent-guide.md)

Use the application’s package scripts for normal development. The commands below also work through `npx boring` after installing `@boringapi/core`.

## Commands

The standard commands handle loading, discovery, type generation, and validation:

```bash
boring init my-api             # scaffold a consumer project
boring add module orders       # scaffold a new domain's public entry points
boring add endpoint orders/get # reuse a matching adapter or create a typed 501 stub
boring dev                     # load ./api, generate types, and restart on changes
boring sync                    # refresh generated types and editor configuration
boring check                   # generate types and check the project with TypeScript
boring inspect                 # find existing routes, operations, schemas and hooks
boring inspect --json          # the same catalog in a versioned machine-readable format
boring build                   # check and compile the consumer application
boring start                   # start the last successful build without a watcher
```

Source commands default to the API directory `./api`. Pass another source path
as a positional argument or with `--dir`. `boring start` automatically selects
the last successful build, including custom output directories and API paths.
The default port is 4040.

```bash
boring dev src/api --port 3000
boring check src/api
boring build src/api
boring start --port 3000
```

`boring dev` loads TypeScript through `ts-node` and the Boring API import transformer, generates types before every restart, and watches the API directory and its sibling `modules`, `infra` and `web` directories, including directories added during development. For example, `boring dev src/api` watches `src/api`, `src/modules`, `src/infra` and `src/web`. Files elsewhere are not watched; keep generated web assets in the build output. `boring check` checks TypeScript, file conventions, route/hook export contracts, and application import boundaries. Architecture checks are mandatory. `boring start` loads compiled JavaScript. `boring sync` generates types and the editor configuration. Use `--project path/to/tsconfig.json` with `dev`, `sync`, `check`, `inspect` or `build` to select another TypeScript configuration.

Add these scripts to the `package.json` of an application that uses Boring API:

```json
{
  "scripts": {
    "dev": "boring dev",
    "check": "boring check",
    "inspect": "boring inspect",
    "sync": "boring sync",
    "build": "boring build",
    "start": "boring start"
  }
}
```

For deployment, copy the complete build output, including `.boring-build.json`,
and install the application's runtime dependencies. `boring start` uses `./dist`
when the local `.boring/build.json` reference is absent. Source files, generated
types and a TypeScript configuration are not required to start that deployment.
Explicit alternatives are:

```bash
boring start --out-dir release/server       # select a complete build directory
boring start --project tsconfig.server.json # use this configuration's outDir
boring start release/server/api             # select compiled API files directly
```

The direct API path also accepts `--dir`. Choose one target selection method;
`--port` works with each. A missing build produces an error asking you to build
first. Start never compiles source or regenerates types. Failed builds preserve
the previous output and do not change the default start target.

## Generate an application, module or endpoint

Use the installed `boring` command (for example through `npx boring`) to start a
consumer. `init` uses the selected project directory, defaulting to the current
directory; it does not select an enclosing project's package.json.

```bash
boring init my-api --dir src/api
cd my-api
npm install
npm run check
npm test
npm run dev
```

The generated application contains a public health endpoint backed by a shared
schema and facade, a typed `+setup`, an infrastructure directory, a compiled HTTP
test, a README and consumer `AGENTS.md`. Package scripts cover dev, sync, inspect,
check, build, test and start. The TypeScript configuration extends the generated
`.boring/tsconfig.json` for `$modules`, `$infra`, `$client` and `./$types`; `.boring`, dependencies and
build output are ignored by Git. Run the sync script after a fresh checkout.
Dev watches the API and its sibling modules, infrastructure and web source.
The generated `AGENTS.md` records project paths and core working rules, and
instructs agents to read the guide from the installed package version:

```bash
node -p "require.resolve('@boringapi/core/agent-guide')"
```

`init` does not install packages or configure authentication/storage. It creates
missing dependency entries and scripts in an existing package.json while preserving
existing values. Conflicting script names, an ESM package, existing application
directories or generated-file collisions stop initialization before source is
written. Use a new directory when the existing project needs a different setup.

Before adding code, inspect the application's capabilities:

```bash
npm run inspect
boring add module invoices --dir src/api
boring add endpoint invoices/get --dir src/api
```

`add module` accepts a lowercase name such as `invoices` or `order-items` and
creates only `facade.ts` and `schemas.ts`. The factory starts empty: implement
the domain's operations and schemas, then import the factory via `$modules` in
`+setup`, inject infrastructure and return the service. The generator prints this
wiring guidance instead of rewriting an application's setup function. Existing
modules are reported with their public exports and must be extended in place.

`add endpoint` takes a filesystem route ending in a lowercase HTTP method, with
no extension. Quote bracket parameters in the shell. For example, after an
application has an orders GET adapter:

```bash
boring add endpoint 'orders/lookup/[id]/get' --dir src/api
# Choose explicitly when more than one existing adapter matches:
boring add endpoint 'orders/archive/[id]/get' --dir src/api --from 'orders/[id]/get'
```

Automatic reuse looks in the same first static URL folder and requires one
TypeScript adapter with the same method, URL parameter names and inherited
middleware, envelope and error hooks. Its schemas, access declarations and
service calls are preserved; relative imports are relocated and `./$types` refers
to the new route. `--from` selects an adapter explicitly and enforces the same
compatibility checks. Multiple automatic matches produce a choice diagnostic.
Review the new URL's intended behavior; the generator does not infer business
arguments, new permissions or new schemas. Without a matching adapter, it creates
a minimal typed handler returning HTTP 501 until implemented.

Both `add` commands inspect and validate the current application without executing
it, then run the same checks against the generated result. A validation failure
removes the newly generated source and restores generated types for the prior
application. There is no force flag, overwrite mode or architecture bypass.
Traversal, symlink destinations, case collisions and ambiguous routes are rejected.
Use `--dir <api-directory>` for another API root and `--project <tsconfig>` with
`add` for a custom configuration. The generated package scripts already carry the
selected API directory; direct `boring add` commands still default to `api`.

## Integrating with an existing server

```ts
// server.ts in the consumer application
import { join } from "path";
import { BoringApi } from "@boringapi/core";

async function main() {
    const app = await new BoringApi().createApp(join(__dirname, "api"));
    app.listen(4040);
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
```

`createApp(directory)` returns an Express application. `listen(directory, port)` starts and returns an HTTP server directly. The loader scans the specified directory at startup and requires loadable `.ts` or `.js` files.

## Module shortcuts, editor support and builds

Use `$modules/<name>/schemas` for shared contracts and `$modules/<name>/facade`
for business operations where the import boundaries permit them. `$modules/`
always names the `modules/` directory beside the selected API directory:
`boring dev src/http` maps it to `src/modules/`. Imports within the same module
can stay relative. The shortcut does not grant access to another module's
private files or let endpoints import facades directly.

Use `$infra/<path>` for adapters and configuration in the sibling `infra/`
directory. For example, `boring dev src/http` resolves `$infra/db/database` to
`src/infra/db/database`. Setup and business modules can use it where the import
boundaries allow infrastructure; routes, browser code, shared schemas and server
pages cannot use the shortcut to bypass those boundaries.

```ts
import { createDatabase } from "$infra/db/database";
import { databaseUrl } from "$infra/config";
```

Run `boring sync src/api` once after a fresh checkout and extend the generated
configuration. For an application under `src/`:

```json
{
  "extends": "./.boring/tsconfig.json",
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "moduleResolution": "node",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"]
}
```

The generated `paths`, `baseUrl` and `rootDirs` settings give the ordinary
TypeScript language service import-path and member completion, hover types,
definition navigation, symbol rename and auto-imports. No Boring API editor
extension, language server or running development server is needed. Configure
your editor to prefer non-relative imports if it should always suggest the
shortcut. The same configuration supports the generated `./$types` imports.

An application's own `paths` object replaces inherited mappings. Preserve the
generated `$modules/*`, `$infra/*` and `$client` entries when adding other aliases; targets
are relative to the effective `baseUrl`. `check`, `inspect` and `build` report `BORING108` at
affected imports if the editor would resolve the shortcut differently. Custom
aliases still need their own runtime/build support: runtime imports are rewritten
for `$modules/` and `$infra/`. The type-only `$client` shortcut is erased from JavaScript
and relocated to the generated contract in declaration output.
One generated configuration describes one selected application; separate
applications should have separate consumer project roots/configurations.

`boring build src/api` runs the same mandatory checks as `boring check`, then
compiles the application to CommonJS. It uses the project's `rootDir` and
`outDir`, defaulting to the API's parent directory and `<project>/dist`.
The build rewrites `$modules` and `$infra` imports, re-exports, literal dynamic imports and
CommonJS requires to relative file paths. These paths follow TypeScript's emitted
extensions, including `.jsx` with `jsx: "preserve"`. Declaration output also
receives resolved paths, including nested import types, and the generated handler
types. Source maps retain source locations. The output runs with ordinary Node
or `boring start`. A successful build records its output directory in
`.boring/build.json` and the emitted API path in the output's `.boring-build.json`.
The emitted API path is relative to the build directory so deployments can move
without retaining the original source paths.

Build output must stay inside the consumer project and outside application source
and `.boring/types`. The first build requires an empty output directory; subsequent
successful builds replace their own output, removing stale routes. The default
`dist` directory is excluded from TypeScript's default file search, just like an
explicit `outDir`. Failed checks
leave the previous build intact. This command does not support `outFile`, separate
`declarationDir`, `composite`, `incremental` or declaration-only builds. It does not
bundle dependencies or copy arbitrary assets. Plain `tsc` does not rewrite the shortcut.

`boring dev` uses the same import transformer through `ts-node`. For JavaScript
modules with separate `.d.ts` declarations, the editor uses the declarations and
the source compiler loads the executable JavaScript companion. For a custom
source server or test runner, register it **before loading application modules**
in a small JavaScript bootstrap outside the scanned API directory:

```js
// bootstrap.cjs
const { join } = require("node:path");
const { registerTypeScript } = require("@boringapi/core/register");
const stop = registerTypeScript(join(__dirname, "src/api"));
require("./src/server.ts");
// Call stop() when the compiler is no longer needed.
```

Run this with `node bootstrap.cjs`. JavaScript tests can use an equivalent
registration-only file with `node --test --require ./test/register.cjs`.
TypeScript test files outside the application's source directory also need their
test runner's TypeScript support, for example
`node --test -r ts-node/register -r ./test/register.cjs test/*.test.ts`.
Use relative imports from those tests into the application; the registered
compiler handles `$modules` and `$infra` inside application source. The registration accepts an
optional second argument naming a TypeScript configuration file and is scoped to
the API's parent directory. Use an absolute API path. Run `boring check` separately
for source type and architecture checks. Compiled applications need no registration.
If the entry script itself uses these aliases, preload the registration before
the script is compiled, as shown in the [fullstack example](https://github.com/PaDreyer/boring-api/tree/master/examples/fullstack).
