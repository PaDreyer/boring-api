# Contributing to Boring API

This document is for working on the framework repository. For application development,
start with the [package README](README.md) and [agent guide](docs/agent-guide.md).

## Workspace layout

The repository uses native pnpm workspaces:

```text
packages/core/       HTTP runtime, browser client and filesystem conventions
packages/compiler/   TypeScript configuration, resolution and source registration
packages/typegen/    route, hook and browser contract generation
packages/analyzer/   static analysis, architecture validation and inspection
packages/build/      portable emission and locating compiled applications
packages/scaffold/   project, module and endpoint scaffolding
packages/dev/        development server workers and source watching
packages/cli/        argument handling, presentation and public API dispatch
examples/basic/      private in-memory API consumer
examples/fullstack/  private PostgreSQL, React and server-page consumer
docs/                shared documentation, included in every tarball
```

The root package is private. Publishable packages own their manifests, dependencies,
implementations and tests under `packages/*`; examples own theirs under `examples/*`.
Declare local package dependencies with `workspace:^` and import public exports.
Core must not depend on development packages; no tool depends on CLI. Keep the
complete graph, including test dependencies, acyclic. `scripts/check-workspaces.js`
checks declared source dependencies, public workspace imports and build order as
part of `pnpm test`. CLI tests exercise the executable; direct tool tests belong
to the owning package. Cross-tool integration tests live in the consuming layer.

The compiler-free convention model at `@boringapi/core/conventions` is shared by
startup and static checks. `generateTypes` belongs to `@boringapi/typegen`, and
source registration to `@boringapi/compiler/register`. See
[package boundaries and APIs](docs/packages.md) for the dependency direction and
entry points. Do not re-export tools from CLI or add reverse test dependencies.

Each package builds to its own `dist/`. Examples import public package exports,
without aliases to library source. Add workspaces with their own `package.json`,
`build`, `typecheck` and `test` scripts. `tsconfig.base.json` holds shared compiler
defaults. Each consumer owns its TypeScript configuration, `.boring/`, aliases and
client contract. Generated files are never committed.

## Local example and checks

Use Node.js 22.12+ for repository development, including Vite. All published packages
support Node.js 18+. Install the pnpm version pinned in the root `packageManager`
field; pnpm 10 also runs on Node.js 18 in the package test matrix.
There is one `pnpm-lock.yaml`. Installation does not compile packages; build before
running consumers. CLI's checked-in `bin/boring.cjs` lets pnpm link the command before
its compiled implementation exists.

```bash
npm install --global pnpm@10.33.4
pnpm install
pnpm build           # builds every package in dependency order
pnpm example:dev
pnpm example:check
pnpm example:inspect # append --json for structured output
pnpm example:sync
pnpm example:build   # compile into examples/basic/dist
pnpm example:start   # run examples/basic/dist/server.js
pnpm typecheck       # packages and both consumer checks
pnpm test            # runtime, tooling and example test suites
pnpm example:fullstack:build
```

`pnpm check` builds packages, checks every workspace and runs tests. After editing
package code, rebuild or keep `pnpm dev` running in another terminal. Restart a
running example after rebuilding; its watcher watches application source.
Target a workspace with `pnpm --filter @boringapi/cli test` or
`pnpm --filter @boringapi/example-basic exec boring inspect --json`.

Repository `example:*` scripts delegate to the named consumer workspace. From inside
an example, use ordinary `pnpm dev`, `pnpm check` and `pnpm build` after building all
packages at the repository root. Examples install CLI as a development dependency;
compiled servers do not import compiler registration. Production deployments use
Core and ordinary Node, without CLI or TypeScript.

See the [basic example](examples/basic/README.md) and the
[fullstack example](examples/fullstack/README.md). The optional PostgreSQL test
requires `BORING_TEST_DATABASE_URL` pointing to an isolated test database; without
it, that test is skipped.

## Documentation and package checks

Keep the README focused on installation, a short example and documentation links.
Update `docs/agent-guide.md` and the relevant reference when conventions or workflows
change. Generated consumer `AGENTS.md` stays short and points to the installed guide.
Repository `AGENTS.md` contains contributor instructions.

All package builds use `scripts/build-package.js`, which compiles only that
package and copies the root `README.md`, `docs/` and `LICENSE` into it. These copies
are ignored by Git; edit root originals. Tarballs contain compiled code and
documentation; CLI also ships `bin/boring.cjs`. Packages do not compile at
installation time. To build and verify every artifact:

```bash
pnpm build
pnpm pack:packages /tmp/boring-release
node scripts/check-package.js /tmp/boring-release/*.tgz
```

Use an empty output directory to avoid retaining tarballs from previous versions.
The packer discovers publishable packages and packs them in dependency order.
The checker validates all archives, exports and documentation, installs them into
a temporary consumer and compiles code using the public TypeScript APIs. It runs
the CLI build, relocates the output and installs a fresh deployment with
`npm ci --omit=dev`. No development package, TypeScript or ts-node may resolve in
production; an HTTP request verifies the generated Node entry point.
The checker needs npm registry access. CI runs it on every supported Node version
and before publishing.

## Publishing

All publishable packages currently share one release version and use `v<version>`
tags. The private root and examples have no release versions. The workflow checks
every package manifest against the tag, builds all packages, packs and tests those
exact artifacts, then publishes in dependency order. The GitHub Release includes
all tarballs and their checksums. Package discovery, packing and release planning
share `scripts/workspaces.js`; new workspace packages do not need an extra list
in GitHub Actions.

Update every package to the next common version, refresh the lockfile and run the
checks above. Commit the version changes with the implementation, then create and
push the matching `v<version>` tag. GitHub Actions builds, tests and publishes the
packages. Publishing skips an existing version only when its registry integrity
matches the exact verified tarball. Different contents under an existing version
fail the release; registry errors other than a missing version also fail it.
