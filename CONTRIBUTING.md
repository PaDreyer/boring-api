# Contributing to Boring API

This document is for working on the framework repository. For application development,
start with the [package README](README.md) and [agent guide](docs/agent-guide.md).

## Workspace layout

The repository uses native pnpm workspaces with no additional task runner:

```text
packages/core/       @boringapi/core, including the CLI for now
examples/basic/      private in-memory API consumer
examples/fullstack/  private PostgreSQL, React and server-page consumer
docs/                shared documentation, included in the core tarball
```

The root package is private. Publishable packages own their manifests, dependencies,
builds and tests under `packages/*`; examples own theirs under `examples/*`.
Declare local package dependencies with `workspace:^`. Each package builds to its
own `dist/`. Examples import the public package exports, without aliases to library
source. Add a new workspace by creating its directory and `package.json`; keep
its `build`, `typecheck` and `test` scripts local to that package.

`tsconfig.base.json` contains shared compiler defaults. Each workspace has its own
TypeScript configuration. Each example owns its `.boring` output, convention
aliases and generated client contract. Generated files are never committed.

## Local example and checks

Use Node.js 22.12+ for repository development, including Vite. The published core
package still supports Node.js 18+. Install the pnpm version pinned in the root
`packageManager` field; pnpm 10 also runs on Node.js 18 in the core test matrix.
There is one `pnpm-lock.yaml` for the repository. Core's `prepare` script builds
the package during `pnpm install`, so the examples' local `boring` command is
available immediately after installation.
The workspace enables peer installation so Core's Zod peer also remains available
to that build during `pnpm install --prod`.

```bash
npm install --global pnpm@10.33.4
pnpm install
pnpm build           # build publishable packages before running consumers
pnpm example:dev     # run the basic API with the local workspace package
pnpm example:check
pnpm example:inspect # append --json for structured output
pnpm example:sync
pnpm example:build   # compile the consumer into examples/basic/dist
pnpm example:start   # run examples/basic/dist/server.js
pnpm typecheck       # library typechecks and both consumer checks
pnpm test            # core and example test suites
```

`pnpm check` builds packages, checks every workspace and runs its tests. After
editing library code, run `pnpm build` again, or keep `pnpm dev` running in another
terminal to watch library compilation. Restart a running example after rebuilding
Core; the application watcher watches application source. Target one workspace
with `pnpm --filter @boringapi/core test` or
`pnpm --filter @boringapi/example-basic exec boring inspect --json`.

Repository `example:*` scripts delegate to the named consumer workspace, so CLI
project discovery, aliases and generated files stay local to that application.
From inside an example directory, use ordinary `pnpm dev`, `pnpm check` and
`pnpm build` commands after building Core at the repository root.

See the [basic example](examples/basic/README.md) for HTTP requests and the
[fullstack example](examples/fullstack/README.md) for PostgreSQL, SPA and MPA setup.
The optional PostgreSQL test requires `BORING_TEST_DATABASE_URL` pointing to an
isolated test database; without it, that test is skipped.

## Documentation and package checks

Keep the README focused on installation, a short example and documentation links.
Update `docs/agent-guide.md` and the relevant reference whenever a convention or
recommended workflow changes. Keep generated project instructions short, with
project-specific paths and a pointer to the installed guide. Repository `AGENTS.md`
contains contributor instructions and is not the consumer guide.

The core build copies the root `README.md`, `docs/` and `LICENSE` into
`packages/core`; those generated copies are ignored by Git. Edit the originals
at the repository root. The npm package includes those files and `dist/`. After building,
verify the actual archive, including documentation links and the installed guide:

```bash
pnpm --filter @boringapi/core pack --pack-destination /tmp
node scripts/check-package.js /tmp/boringapi-core-0.0.1.tgz
```

Use the filename printed by `pnpm pack` when checking another package version.
The release workflow runs the same archive check before publishing.

## Publishing

A `v<version>` tag starts the release workflow. The tag must exactly match the version in `packages/core/package.json`; for example, `v0.0.1` matches `"version": "0.0.1"`. Before publishing, the workflow runs the example check, TypeScript check, tests, and build. It then creates an npm tarball, publishes it through npm Trusted Publishing, and creates a GitHub Release with a checksum and automatically generated release notes.

The Trusted Publisher for `@boringapi/core` uses the following GitHub Actions settings:

- Organization or user: `PaDreyer`
- Repository: `boring-api`
- Workflow file: `release.yml`
- Permitted action: `npm publish`

Because a Trusted Publisher can only be configured for an existing npm package, publish the first version interactively once from a verified core tarball with
`npm publish /tmp/boringapi-core-0.0.1.tgz --access public`. Then enable the Trusted Publisher in the package settings; subsequent versions are created exclusively through matching Git tags.

Only Core is published today, so releases retain the existing `v<version>` tags.
The private root and examples have no release versions. Update Core and the shared
lockfile, run checks and inspect the tarball before committing and tagging:

```bash
pnpm --filter @boringapi/core exec npm version patch --no-git-tag-version
pnpm install --lockfile-only
pnpm check
pnpm --filter @boringapi/core pack --pack-destination /tmp
# Check the printed archive with scripts/check-package.js, then commit the changes.
git add packages/core/package.json pnpm-lock.yaml
git commit -m "Release @boringapi/core"
# Replace <version> with packages/core/package.json's version.
git tag -a v<version> -m "Release @boringapi/core <version>"
git push origin master --follow-tags
```

Use `minor` or `major` instead of `patch` for those releases. The workflow packs
Core with pnpm, validates that artifact and publishes the same tarball through npm
Trusted Publishing. When additional packages need independent releases, introduce
a multi-package versioning process such as Changesets; the workspace setup does
not require one while only Core is published.
