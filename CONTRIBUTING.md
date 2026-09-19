# Contributing to Boring API

This document is for working on the framework repository. For application development,
start with the [package README](README.md) and [agent guide](docs/agent-guide.md).

## Local example and checks

This section applies only when working on the `boring-api` repository. These scripts are not copied into consumer applications; those use the `boring` command from the installed package as described in the [package README](README.md). Use Node.js 22.12+ to work on the full repository, including its Vite example. The core package supports Node.js 18+. The repository includes a `yarn.lock`.

```bash
yarn install
yarn example:dev     # run the local source against examples/basic/api
yarn example:check   # check the local example
yarn example:inspect # discover the example's routes and existing operations
yarn example:sync    # generate the local example's types and editor configuration
yarn example:build   # compile the example and its local library into .boring/example-build
yarn example:start   # start examples/basic/server.ts
yarn typecheck
yarn test
yarn build           # compile only the library into dist
```

The example keeps explicit `$modules/*` and `$infra/*` entries in the repository's tsconfig
because the repository also generates types for independent test applications.
`tsconfig.example.json` selects its application build. Run the compiled example
with `node .boring/example-build/examples/basic/server.js`.

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

The npm package includes `dist`, `README.md`, `docs` and `LICENSE`. After building,
verify the actual archive, including documentation links and the installed guide:

```bash
npm pack --pack-destination /tmp
node scripts/check-package.js /tmp/boringapi-core-0.0.1.tgz
```

Use the filename printed by `npm pack` when checking another package version.
The release workflow runs the same archive check before publishing.

## Publishing

A `v<version>` tag starts the release workflow. The tag must exactly match the version in `package.json`; for example, `v0.0.1` matches `"version": "0.0.1"`. Before publishing, the workflow runs the example check, TypeScript check, tests, and build. It then creates an npm tarball, publishes it through npm Trusted Publishing, and creates a GitHub Release with a checksum and automatically generated release notes.

The Trusted Publisher for `@boringapi/core` uses the following GitHub Actions settings:

- Organization or user: `PaDreyer`
- Repository: `boring-api`
- Workflow file: `release.yml`
- Permitted action: `npm publish`

Because a Trusted Publisher can only be configured for an existing npm package, publish the first version interactively once with `npm publish --access public`. Then enable the Trusted Publisher in the package settings; subsequent versions are created exclusively through matching Git tags.

For a regular patch release, `npm version patch` increments the version in `package.json`, creates a release commit, and adds the matching Git tag. Pushing afterward transfers the branch and tag, which starts the release workflow:

```bash
npm version patch
git push origin master --follow-tags
```

Use `npm version minor` or `npm version major` for minor or major releases, respectively.
