# Package boundaries and programmatic APIs

Boring API publishes separate packages for the HTTP runtime and each development
responsibility. Applications normally install `@boringapi/core` and `zod` as
dependencies and `@boringapi/cli` as a development dependency. The CLI installs
the tools it uses through ordinary package dependencies. Each package contains
only its own compiled implementation; cross-package imports use public exports.

| Package | Responsibility | Public entry points |
| --- | --- | --- |
| `@boringapi/core` | Application/execution lifecycle, HTTP runtime, browser transport and shared filesystem conventions | Root runtime API; `/client`; `/conventions`; `/agent-guide` |
| `@boringapi/jobs-postgres` | Optional compiler-free durable queue; borrows the application PostgreSQL pool | `createPostgresJobs`, `jobMigration`, `triggerMigration`, `JobRecord` |
| `@boringapi/compiler` | TypeScript configuration, alias resolution, import transforms and symbol analysis | Root compiler utilities; `/register` for `registerTypeScript` |
| `@boringapi/typegen` | HTTP and trigger types, standalone browser contracts | `generateTypes`, `generateClientContracts`, `TypegenResult` |
| `@boringapi/analyzer` | Static project analysis, architecture checks and inspection | `analyzeProject`, `synchronizeProject`, `checkArchitecture`, `inspectProject` and diagnostic/catalog formatting |
| `@boringapi/build` | Portable application emission and locating compiled output | `buildProject`, `resolveStartDirectory`, `startProject`, `startWorker` |
| `@boringapi/scaffold` | Project, module, endpoint and trigger scaffolding | `initializeProject`, `addModule`, `addEndpoint`, `addJob`, `addTrigger` |
| `@boringapi/dev` | Source watching and isolated server workers | `startDevServer`, `runSourceCommand`, `DevServer` |
| `@boringapi/cli` | Command arguments, result presentation and API dispatch | The `boring` executable; no library entry point |

Core has no dependency on the development packages. Compiler utilities form the
foundation of the tooling. Type generation depends on Core and Compiler; Analyzer
uses those generated contracts. Build, Scaffold and Dev consume these lower
layers. No tool depends on CLI. Type generation and source scaffolding are
separate because analysis needs generated types while scaffolding needs analysis.

Every package exposes `/package.json` for tooling that needs package metadata.
Internal source files and compiled subpaths are not public APIs.

Core exports `BoringApi`, the `Application` owner type, `ApplicationOptions`,
`ExecutionContext`, `ExecutionIdentity`, `ExecutionScope`, `ExecutionOptions`,
`ApplicationError`, `ExecutionError`, `LifecycleError` and `ShutdownTimeoutError`.
Job runtime types include `JobContext`, `JobAdapter`, `JobPort`, `JobReceipt`,
`JobPolicy`, `JobClaim` and `WorkerOptions`; `JobError` describes permanent delivery
failures. Application adds `runJob()` and `work()`, setup adds `jobs()`.
See [durable jobs](jobs.md) and [lifecycle and migration](lifecycle.md) for construction, controlled execution
and disposal. These exports require no compiler or development package.

Trigger types include `ScheduleContext`, `EventContext`, `CommandContext`,
`ScheduleTiming`, `ScheduleOccurrence`, `EventMetadata`, `EventReceipt` and
`TriggerAdapter`. Application adds `tick`, `schedule`, `acceptEvent` and `command`;
setup adds `schedules`, `events` and `commands`. The [trigger reference](triggers.md)
defines their contracts and the shared `commandFailure` transport vocabulary.

## Releases and compatibility

All packages share a platform release version, including unchanged packages and
the CLI version recommended by `initializeProject`. They are tested together and
remain independently installable. During `0.x`, patch releases within a minor line
remain compatible; minor releases may require application changes. From `1.0.0`,
incompatible public changes require a new platform major version.

Published package dependencies use caret ranges. For example, `^0.1.0` permits
stable versions `>=0.1.0 <0.2.0`, so compatible installed versions can differ even
though releases share a version. See the
[platform versioning and release policy](https://github.com/PaDreyer/boring-api/blob/master/CONTRIBUTING.md#publishing)
for the complete rules.

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

`startDevServer(root, apiDirectory, port?, projectFile?, worker = false)` returns a `DevServer`
with an idempotent asynchronous `close()` method. Set worker to true for jobs,
`"scheduler"` for schedule admission, `"schedule"` for schedule delivery or `"event"`
for consumers. `runSourceCommand(root, apiDirectory, name, input, projectFile?, signal?)`
checks and invokes an application command once, then awaits cleanup;
source admission runs the shared mandatory checks before each start/restart. It owns its watcher and child
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
