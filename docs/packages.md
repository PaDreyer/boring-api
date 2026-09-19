# Package boundaries and programmatic APIs

Boring API publishes separate packages for the HTTP runtime and each development
responsibility. Applications normally install `@boringapi/core` and `zod` as
dependencies and `@boringapi/cli` as a development dependency. The CLI installs
the tools it uses through ordinary package dependencies. Each package contains
only its own compiled implementation; cross-package imports use public exports.

| Package | Responsibility | Public entry points |
| --- | --- | --- |
| `@boringapi/core` | HTTP runtime, browser transport and shared filesystem conventions | Root runtime API; `/client`; `/conventions`; `/agent-guide` |
| `@boringapi/compiler` | TypeScript configuration, alias resolution, import transforms and symbol analysis | Root compiler utilities; `/register` for `registerTypeScript` |
| `@boringapi/typegen` | Route and hook types, standalone browser contracts | `generateTypes`, `generateClientContracts`, `TypegenResult` |
| `@boringapi/analyzer` | Static project analysis, architecture checks and inspection | `analyzeProject`, `synchronizeProject`, `checkArchitecture`, `inspectProject` and diagnostic/catalog formatting |
| `@boringapi/build` | Portable application emission and locating compiled output | `buildProject`, `resolveStartDirectory`, `startProject` |
| `@boringapi/scaffold` | Project, module and endpoint scaffolding | `initializeProject`, `addModule`, `addEndpoint` |
| `@boringapi/dev` | Source watching and isolated server workers | `startDevServer`, `DevServer` |
| `@boringapi/cli` | Command arguments, result presentation and API dispatch | The `boring` executable; no library entry point |

Core has no dependency on the development packages. Compiler utilities form the
foundation of the tooling. Type generation depends on Core and Compiler; Analyzer
uses those generated contracts. Build, Scaffold and Dev consume these lower
layers. No tool depends on CLI. Type generation and source scaffolding are
separate because analysis needs generated types while scaffolding needs analysis.

Every package exposes `/package.json` for tooling that needs package metadata.
Internal source files and compiled subpaths are not public APIs. The packages
currently share a release version, including the CLI version recommended by
`initializeProject`.

## Use tools without the CLI

Declare each package imported by your own scripts as a direct development
dependency, even if CLI already installs it transitively:

```bash
npm install --save-dev @boringapi/analyzer @boringapi/build
```

```ts
import { analyzeProject } from "@boringapi/analyzer";
import { buildProject } from "@boringapi/build";

const project = analyzeProject(process.cwd(), "api");
if (project.diagnostics.length || project.architecture.length) {
    throw new Error("Fix project diagnostics before building.");
}
const result = buildProject(project);
if (result.diagnostics.length) throw new Error("Application emission failed.");
```

Analysis and generators inspect source without executing application modules.
`generateTypes(root, apiDirectory)` refreshes route and hook types;
`synchronizeProject(root, apiDirectory, projectFile?)` also analyzes and refreshes
browser contracts when the application has `web/client` source.

For a custom source bootstrap, install `@boringapi/compiler` as a development
dependency and import `registerTypeScript` from `@boringapi/compiler/register`.
The compiler root entry does not register loaders. See the
[source compiler workflow](cli.md#module-shortcuts-editor-support-and-builds).

`startDevServer(root, apiDirectory, port?, projectFile?)` returns a `DevServer`
with an idempotent asynchronous `close()` method. It owns its watcher and child
processes; the caller owns process signal handling. On reload and close it sends
SIGTERM, then SIGKILL after five seconds if the worker has not exited.
The CLI wires SIGINT/SIGTERM to this lifecycle.

## Production and browser code

Build with development dependencies available. Deploy compiled output with
`npm ci --omit=dev` and start `node dist/boring-start.cjs` or a compiled custom
server. No development package, TypeScript or ts-node is needed in production.
`startProject` is a tooling convenience; use the generated Node entry point for
production deployments.

Browser source uses `@boringapi/core/client` and generated `$client` types.
Runtime imports of development packages and the server convention scanner are
rejected by architecture checks, including aliases and re-exports. Development
bootstraps and tests keep compiler registration outside compiled server entries.
