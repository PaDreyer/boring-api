# Boring API

An API made from files: folders define URL paths, while `get.ts` and `post.ts` define HTTP methods. Files prefixed with `+` control shared behavior. Boring API connects them automatically at startup, without nested routers or decorators.

```text
api/
├── +setup.ts                  initialize services once
├── +auth.ts                   authentication and authorization
├── +middleware.ts             middleware for all routes
├── +envelope.ts               response format for all routes
├── +error.404.ts              error response for HTTP 404
└── items/
    ├── +middleware.ts         additional middleware for /items/* only
    ├── latest/get.ts          GET /items/latest
    └── [id]/get.ts            GET /items/:id
```

The API directory belongs to the application. It can have any name; the application passes its path to Boring API. `src` contains only the library. A separate, runnable example is available under `examples/basic`.

## Installation

`@boringapi/core` is the published Node module. It installs the executable `boring` command through the package's `bin` field:

```bash
npm install @boringapi/core zod
# or: pnpm add @boringapi/core zod
# or: yarn add @boringapi/core zod
```

After a local installation, the command is available in the application's package scripts. You can also run it directly with `npx boring`, `pnpm exec boring`, or `yarn boring`.

## CLI

The three standard commands handle loading, type generation, and validation:

```bash
boring dev                 # load ./api, generate types, and restart on changes
boring check               # generate types and check the project with TypeScript
boring start               # start the compiled API without a watcher
```

The API directory defaults to `./api`. Pass another path as a positional argument or with `--dir`. The default port is 4040.

```bash
boring dev src/api --port 3000
boring check src/api
boring start dist/api --port 3000
```

`boring dev` loads TypeScript through `ts-node`, generates types before every restart, and watches the API directory. `boring check` checks TypeScript, file conventions, and the export contracts of every route and hook. `boring start` is intended for compiled JavaScript. `boring sync` only generates the type files.

Add these scripts to the `package.json` of an application that uses Boring API:

```json
{
  "scripts": {
    "dev": "boring dev",
    "check": "boring check",
    "start": "boring start dist/api"
  }
}
```

### Integrating with an existing server

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

`createApp(directory)` returns an Express application. `listen(directory, port)` starts and returns an HTTP server directly. `scan(directory, port)` remains available as a legacy alias. The loader scans the specified directory at startup and requires loadable `.ts` or `.js` files.

## Adding a route

The names `get.ts`, `post.ts`, `put.ts`, `patch.ts`, `delete.ts`, `head.ts`, and `options.ts` are reserved. A `get.ts` directly inside `api/` handles `GET /`. A folder named `[id]` becomes the `:id` URL parameter. Static routes take precedence over dynamic routes. Duplicate or unknown convention files cause startup to fail.

```ts
// api/articles/[id]/get.ts
import z from "zod";
import { HttpError } from "@boringapi/core";
import type { GetHandler } from "./$types";

type ArticleStore = {
    find(id: string): Promise<{ id: string; title: string } | undefined>;
};

export const params = z.object({ id: z.string().min(1) });
export const output = z.object({ id: z.string(), title: z.string() });
export const authentication = true;

export const handler: GetHandler = async ctx => {
    const store = ctx.services.articles;
    const { id } = ctx.params;
    const article = await store.find(id);
    if (!article) throw new HttpError(404, "Article not found");
    return article;
};
```

Here, `ArticleStore` represents the type of an application-owned service. It is registered in `+setup.ts`. See `examples/basic/api` for a directly reusable demo.

| Method file export | Effect |
| --- | --- |
| `handler: GetHandler` | Required; types the context and return value from this file. Other methods use `PostHandler`, `PatchHandler`, and so on. |
| `params`, `query`, `body` | Optional Zod schemas for URL parameters, query parameters, and the JSON body. |
| `output` | Optional Zod schema for the response before the envelope is applied. |
| `authentication = true` | Requires a session from `+auth.ts`; returns HTTP 401 without one. |
| `authorization = rule` | Requires a session and passes `rule` to `authorize()` in `+auth.ts`. |
| `envelope = false` | Skips the inherited envelope for this route. |

Invalid input returns HTTP 400; invalid output returns HTTP 500. A handler with no return value and no `ctx.payload` returns HTTP 204. Setting `ctx.payload = value` is an alternative to returning a value. `ctx.status(201)` sets the success status. `ctx.send(value)` sends immediately, bypassing `output` validation and the envelope.

## Generated types

`boring dev`, `boring check`, and `boring sync` generate a virtual `$types` module under `.boring/types` for every route directory. The generator does not evaluate application code or duplicate schemas. The generated types reference the exports of the corresponding method file:

- `params`, `query`, and `body` are typed according to their Zod output.
- The return value of `GetHandler` or `PostHandler` must match the input of the `output` schema.
- The return value of `+setup.ts` becomes `ctx.services`.
- The return value of `authenticate()` becomes `ctx.session`. On protected routes, `session` is not optional.
- The type of the second `authorize()` parameter limits the permitted values of the `authorization` export.
- The return values of all inherited `+middleware.ts` files are merged into `ctx.locals`.

Generated files are not committed. There are two ways to make the editor resolve `./$types` in the same way as `boring check`. A simple project can extend the generated configuration from its `tsconfig.json`:

```json
{
  "extends": "./.boring/tsconfig.json",
  "compilerOptions": {
    "strict": true
  }
}
```

If the application already extends another base configuration, add only `rootDirs` instead:

```json
{
  "compilerOptions": {
    "rootDirs": [".", ".boring/types"]
  }
}
```

The configuration is created the first time you run `boring sync`, `boring dev`, or `boring check`. `boring check` sets `rootDirs` itself, so it also works without this editor setting.
The API directory must be inside the project because its location is mapped to the generated `.boring/types` directory.

## Files prefixed with `+`

The filenames form the framework's contract. Shared logic does not require manually nested Express routers.

| File | Location and lifetime | Contract |
| --- | --- | --- |
| `+setup.ts` | API root only; once per `createApp()` | `setup(ctx)` returns an object containing long-lived services. It is typed as `ctx.services`. Manual `ctx.set()` calls remain supported but cannot be inferred. |
| `+auth.ts` | API root only; for every matched route | `authenticate(ctx)` returns a session. `authorize(ctx, rule)` checks a route rule. Both exports are optional, but at least one is required. |
| `+middleware.ts` | Any URL folder; once per request from the root to the route folder | `handler(ctx)` returns new request locals. They are typed as `ctx.locals` in subsequent steps. An early response with `ctx.send()` is supported. |
| `+envelope.ts` | Any URL folder; for every successful response | `handler(ctx)` returns the formatted response or sets `ctx.payload`. The nearest file applies. |
| `+error.ts`, `+error.404.ts`, `+error.500.ts` | Any URL folder; when an error occurs | `handler(ctx, error)` returns the error response. The nearest template applies; a matching status-specific file in the same folder takes precedence. |

Middleware **stacks** along the URL path. Envelopes and error responses, by contrast, **override** an inherited template instead of being nested repeatedly. An unmatched path uses the error response defined at the API root. Empty HTTP 204 responses are not wrapped in an envelope.

In the early prototype, these responsibilities lived in `_base/` and `_setup/`. These collection folders have been replaced by explicit `+` files: `_setup/*` becomes `+setup.ts`, authentication and authorization from `_base/` become `+auth.ts`, the envelope file becomes `+envelope.ts`, and `404.ts` becomes `+error.404.ts`. At startup, the legacy folders trigger a message pointing to the new conventions.

Safe defaults apply when convention files are absent: no session, HTTP 401 for protected routes without a session, HTTP 403 for an authorization rule without `authorize()`, unchanged successful responses, and JSON error responses without internal server details. A default logger is provided. `+auth.ts` and `+setup.ts` replace or extend this behavior as needed. The example at `examples/basic/api/+auth.ts` uses an environment token for demonstration purposes only.

## Context and request flow

Every request receives its own `Context`. `ctx.request` and `ctx.response` are the Express objects. `ctx.params`, `ctx.query`, and `ctx.body` contain validated input. `ctx.services`, `ctx.session`, and `ctx.locals` are inferred from convention files. The `get()` and `set()` map methods remain available for dynamic edge cases; return values are the standard typed approach. Request data does not belong in global variables or the setup context.

Each route runs through: authentication → inherited middleware → session check → authorization → input validation → handler → output validation → nearest envelope → send. Every step is awaited. If an error occurs, the matching error file receives the same request context.

## Local example and checks

This section applies only when working on the `boring-api` repository. These scripts are not copied into consumer applications; those use the `boring` command from the installed package as described above. Node.js 18 or newer is required. The repository includes a `yarn.lock`.

```bash
yarn install
yarn example:dev     # run the local source against examples/basic/api
yarn example:check   # check the local example
yarn example:sync    # generate only the local example's types
yarn example:start   # start examples/basic/server.ts
yarn typecheck
yarn test
yarn build           # compile only the library into dist
```

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

The example server listens on port 4040 by default; set `PORT` to change it.

```bash
curl http://localhost:4040/health
curl http://localhost:4040/items/42
curl -X POST http://localhost:4040/echo \
  -H 'Content-Type: application/json' \
  -d '{"message":"Hello"}'
```

The responses are `{"service":"boring-api","status":"ok"}`, `{"id":"42"}`, and `{"data":{"message":"Hello"}}`. The current scope supports JSON bodies and individual dynamic segments such as `[id]`. Catch-all segments are not defined yet.
