import { basename, dirname, posix } from "path";

export function factoryName(name: string): string {
    return `create${name.split("-").map(part => part[0].toUpperCase() + part.slice(1)).join("")}`;
}

export function moduleTemplate(name: string): Record<string, string> {
    return {
        "facade.ts": `/** Public entry point: check access and coordinate private services and injected adapters. */
export function ${factoryName(name)}() {
    return {};
}
`,
        "service.ts": `/** Private business rules for this module. Add operations as the domain takes shape. */
export {};
`,
        "schemas.ts": `// Define shared Zod schemas here and infer their TypeScript types.
// Reuse existing public schemas before adding a new contract.
export {};
`,
    };
}

export function endpointTemplate(method: string): string {
    const handler = `${method[0].toUpperCase()}${method.slice(1)}Handler`;
    return `import { HttpError } from "@boringapi/core";
import type { ${handler} } from "./$types";

export const handler: ${handler} = () => {
    // Reuse public schemas and call an existing operation through ctx.services.
    // Declare its authentication/authorization requirements before serving data.
    throw new HttpError(501, "Not implemented");
};
`;
}

/** API paths are validated before interpolating them into scripts or instructions. */
export function consumerScripts(api: string): Record<string, string> {
    const argument = api === "api" ? "" : ` ${api}`;
    return {
        dev: `boring dev${argument}`,
        check: `boring check${argument}`,
        inspect: `boring inspect${argument}`,
        sync: `boring sync${argument}`,
        build: `boring build${argument}`,
        start: "node dist/boring-start.cjs",
        test: `boring build${argument} && node --test test/*.test.cjs`,
    };
}

export function consumerTemplates(api: string): Record<string, string> {
    const parent = dirname(api);
    const modules = posix.join(parent, "modules");
    const infra = posix.join(parent, "infra");
    const argument = api === "api" ? "" : ` --dir ${api}`;
    return {
        "tsconfig.json": JSON.stringify({
            extends: "./.boring/tsconfig.json",
            compilerOptions: { target: "ES2020", module: "commonjs", moduleResolution: "node",
                esModuleInterop: true, strict: true, skipLibCheck: true, rootDir: parent, outDir: "dist",
                declaration: true, sourceMap: true },
            include: parent === "." ? [`${api}/**/*.ts`, `${modules}/**/*.ts`, `${infra}/**/*.ts`] : [`${parent}/**/*.ts`],
        }, null, 2) + "\n",
        ".gitignore": "node_modules/\n.boring/\ndist/\n",
        [`${infra}/.gitkeep`]: "",
        [`${api}/+setup.ts`]: `import type { SetupContext } from "./$types";
import { createHealth } from "$modules/health/facade";

export function setup(_ctx: SetupContext) {
    return { health: createHealth() };
}
`,
        [`${modules}/health/schemas.ts`]: `import { z } from "zod";

export const health = z.object({ status: z.literal("ok") });
export type Health = z.infer<typeof health>;
`,
        [`${modules}/health/facade.ts`]: `import type { Health } from "./schemas";

export function createHealth() {
    return { get(): Health { return { status: "ok" }; } };
}
`,
        [`${api}/health/get.ts`]: `import { health } from "$modules/health/schemas";
import type { GetHandler } from "./$types";

export const output = health;
export const handler: GetHandler = ctx => ctx.services.health.get();
`,
        "test/health.test.cjs": `const assert = require("node:assert/strict");
const { it } = require("node:test");
const { join } = require("node:path");
const { request } = require("node:http");
const { BoringApi } = require("@boringapi/core");

it("serves the health contract", async () => {
    const app = await new BoringApi().createApp(join(__dirname, "../dist/${basename(api)}"));
    const server = await new Promise((resolve, reject) => {
        const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
        listening.once("error", reject);
    });
    try {
        const response = await new Promise((resolve, reject) => {
            const req = request({ hostname: "127.0.0.1", port: server.address().port, path: "/health" }, res => {
                let body = "";
                res.setEncoding("utf8");
                res.on("data", chunk => { body += chunk; });
                res.on("end", () => resolve({ status: res.statusCode, body }));
            });
            req.on("error", reject);
            req.end();
        });
        assert.equal(response.status, 200);
        assert.deepEqual(JSON.parse(response.body), { status: "ok" });
    } finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
});
`,
        "AGENTS.md": `# Working on this Boring API application

Before changing application code, read the Agent guide shipped with the installed
\`@boringapi/core\` version. Locate it from this project root:

\`\`\`sh
node -p "require.resolve('@boringapi/core/agent-guide')"
\`\`\`

Read the returned file and follow its links for detailed framework contracts.
Keep project-specific instructions here; do not copy the package guide into this file.

## This project

- API and hooks: \`${api}/\`. Setup: \`${api}/+setup.ts\`.
- Business modules: \`${modules}/<name>/facade.ts\` and \`schemas.ts\` are public;
  private \`service.ts\` holds business rules. Add a private \`repository.ts\` port
  when storage is needed. Import public entries through \`$modules\`.
- Infrastructure: \`${infra}/\`, imported through \`$infra/<path>\` where allowed.
  Setup constructs adapters and injects them into facades returned as services.
- Web source, if added: \`${posix.join(parent, "web/client")}/\` for the browser,
  \`${posix.join(parent, "web/server")}/\` for server presentation using injected facades.
- The generated health endpoint is public. No identity provider or persistent
  storage is configured. Add application-specific access and integration details here.

## Working rules

1. Run \`npm run sync\` after checkout and \`npm run inspect\` before adding code
   (\`npm run inspect -- --json\` for structured output). Read the existing operations
   and reuse their public facade operations. Extend business rules in the owning
   module's service; preserve the architecture explained in the installed guide.
2. Keep routes thin: generated \`./$types\`, shared schemas, access declarations,
   calls to \`ctx.services\`, status and returned payloads. Enforce permissions in
   business operations too; pass actors per call and keep request state out of
   shared services. Never edit or commit \`.boring/\`.
3. For a new domain use \`npx boring add module <name>${argument}\`. Add routes with
   \`npx boring add endpoint '<path/method>'${argument}\`; use \`--from\` to select a
   compatible existing adapter. Review inherited hooks and access. New stubs return
   501 until implemented; new modules need explicit setup wiring.
4. Verify with \`npm run check\`, \`npm test\` and \`npm run build\`. Fix mandatory
   architecture diagnostics at their source. Use \`npm run dev\` during development
   and \`npm start\` for the compiled API; build through Boring API so aliases resolve.
`,
        "README.md": `# Boring API application

Install dependencies, generate editor types and start developing:

\`\`\`sh
npm install
npm run sync
npm run check
npm test
npm run dev
\`\`\`

GET /health returns \`{ "status": "ok" }\` through the shared health facade and
schema. It is public; no identity provider or persistent storage is configured.

Run \`npm run inspect\` before extending an existing module. Add a new domain
with \`boring add module invoices${argument}\`. Put business rules in its private
\`service.ts\`, expose operations through \`facade.ts\`, inject infrastructure in
\`${api}/+setup.ts\`, and return the facade there.
Add HTTP adapters with \`boring add endpoint invoices/get${argument}\`.
Without an existing template, a new adapter returns 501 until implemented.
To reuse health at another URL, run
\`boring add endpoint health/live/get${argument} --from health/get\`.
Generators preserve existing files; inspect the generated diff and effective hooks.

\`npm run dev\` restarts on changes to \`${api}\`, \`${modules}\`, \`${infra}\` and sibling web source.
Use \`npm run build\` followed by \`npm start\` for compiled execution. The build
rewrites \`$modules\` and \`$infra\` imports and checks types, conventions and architecture first.
See [AGENTS.md](AGENTS.md) for project rules and the installed package’s Agent guide.
`,
    };
}
