import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import ts from "typescript";
import { analyzeProject } from "../src/core/project";
import { BoringApi } from "../src";
import { ApiError, createClient } from "../src/client";
import { registerTypeScript } from "../src/register";

const repository = join(__dirname, "..");

function consumer(files: Record<string, string>, run: (root: string) => void | Promise<void>) {
    const root = mkdtempSync(join(tmpdir(), "boring-clientgen-"));
    let pending = false;
    try {
        for (const [file, content] of Object.entries({
            "package.json": '{"name":"browser-consumer"}',
            "tsconfig.json": JSON.stringify({ compilerOptions: {
                strict: true, skipLibCheck: true, esModuleInterop: true, target: "ES2020", module: "commonjs",
                baseUrl: ".", paths: { "@boringapi/core": [join(repository, "src/index.ts")],
                    "@boringapi/core/client": [join(repository, "src/client.ts")], zod: [join(repository, "node_modules/zod")] },
            } }),
            "modules/orders/schemas.ts": `import z from "zod";
                export const input = z.object({ item: z.string(), quantity: z.string().transform(Number) });
                export const output = z.object({ id: z.string(), quantity: z.number(), created: z.date() });`,
            "api/orders/post.ts": `import { input, output } from "../../modules/orders/schemas";
                import type { PostHandler } from "./$types";
                export { output }; export const body = input;
                throw new Error("application code must not execute");
                export const handler: PostHandler = ctx => ({ id: "one", quantity: ctx.body.quantity, created: new Date() });`,
            "api/orders/[id]/get.ts": `import { output } from "../../../modules/orders/schemas";
                export { output }; export const handler = () => { throw new Error("not executed"); };`,
            "web/client/api.ts": `import { createClient } from "@boringapi/core/client";
                import type { ApiRoutes } from "../../api/$client";
                export const api = createClient<ApiRoutes>("/api");
                async function verify() {
                    const result = await api.request("POST /orders", { body: { item: "Book", quantity: "2" } });
                    const quantity: number = result.quantity;
                    const created: string = result.created;
                    // @ts-expect-error Client input uses the schema input, before transformations.
                    api.request("POST /orders", { body: { item: "Book", quantity: 2 } });
                    // @ts-expect-error URL parameters are required.
                    api.request("GET /orders/:id");
                    // @ts-expect-error Unknown endpoints are rejected.
                    api.request("POST /absent");
                }`,
            ...files,
        })) {
            mkdirSync(dirname(join(root, file)), { recursive: true });
            writeFileSync(join(root, file), content);
        }
        const result = run(root);
        if (result) {
            pending = true;
            return result.finally(() => rmSync(root, { recursive: true, force: true }));
        }
    } finally { if (!pending) rmSync(root, { recursive: true, force: true }); }
}

function clean(project: ReturnType<typeof analyzeProject>) {
    assert.deepEqual(project.architecture.map(error => error.message), []);
    assert.deepEqual(project.diagnostics.map(error => ts.flattenDiagnosticMessageText(error.messageText, "\n")), []);
}

async function withHttp(root: string, run: (baseUrl: string) => Promise<void>) {
    symlinkSync(join(repository, "node_modules"), join(root, "node_modules"), "dir");
    const unregister = registerTypeScript(join(root, "api"));
    let server: import("node:http").Server | undefined;
    try {
        const app = await new BoringApi().createApp(join(root, "api"));
        server = await new Promise<import("node:http").Server>((resolve, reject) => {
            const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
            listening.once("error", reject);
        });
        await run(`http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`);
    } finally {
        if (server) await new Promise<void>((resolve, reject) => {
            server!.close(error => error ? reject(error) : resolve()); server!.closeAllConnections();
        });
        unregister();
    }
}

it("derives browser contracts without executing modules or referring to server types", () => {
    consumer({}, root => {
        const project = analyzeProject(root, "api");
        clean(project);
        const contract = readFileSync(join(root, ".boring/types/api/$client.d.ts"), "utf8");
        assert.doesNotMatch(contract, /\bimport\s*[("{]/);
        assert.match(contract, /quantity.*string/);
        assert.match(contract, /created.*string/);
        assert.match(contract, /GET \/orders\/:id/);
        // Repeated generation must not retain stale routes.
        rmSync(join(root, "api/orders/[id]"), { recursive: true });
        writeFileSync(join(root, "web/client/api.ts"), 'export {};');
        clean(analyzeProject(root, "api"));
        assert.doesNotMatch(readFileSync(join(root, ".boring/types/api/$client.d.ts"), "utf8"), /GET \/orders/);
    });
});

it("describes effective envelopes and preserves the explicit opt-out", () => {
    consumer({
        "api/+envelope.ts": 'export const handler = () => ({ data: "wrapped", version: 1 });',
        "api/plain/get.ts": 'import z from "zod"; export const envelope = false; export const output = z.boolean(); export const handler = () => true;',
        "web/client/api.ts": `import { createClient } from "@boringapi/core/client";
            import type { ApiRoutes } from "../../api/$client";
            const api = createClient<ApiRoutes>();
            async function verify() {
                const wrapped: { data: string; version: number } = await api.request("GET /orders/:id", { params: { id: "1" } });
                const plain: boolean = await api.request("GET /plain");
            }`,
    }, root => clean(analyzeProject(root, "api")));
});

it("keeps empty handlers without output schemas unknown even under an envelope", async () => {
    await consumer({
        "api/orders/post.ts": 'export const handler = () => ({ ok: true });',
        "api/+envelope.ts": 'export const handler = () => ({ ok: true });',
        "api/empty/get.ts": 'export const handler = () => undefined;',
        "api/conditional/get.ts": `import type { GetHandler } from "./$types";
            export const handler: GetHandler = ctx => ctx.request.header("x-payload") ? { id: "one" } : undefined;`,
        "api/imperative/get.ts": `import type { GetHandler } from "./$types";
            export const handler: GetHandler = ctx => { ctx.payload = { id: "one" }; };`,
        "api/declared/get.ts": 'import z from "zod"; export const output = z.undefined(); export const handler = () => undefined;',
        "web/client/api.ts": `import { createClient } from "@boringapi/core/client";
            import type { ApiRoutes } from "../../api/$client";
            const api = createClient<ApiRoutes>();
            async function verify() {
                // @ts-expect-error An empty handler can finish with 204 before the envelope runs.
                (await api.request("GET /empty")).ok;
                // @ts-expect-error A conditional payload does not guarantee that the envelope runs.
                (await api.request("GET /conditional")).ok;
                // @ts-expect-error A void return does not imply an empty response when ctx.payload is set.
                const empty: undefined = await api.request("GET /imperative");
                const declared: { ok: boolean } = await api.request("GET /declared");
            }`,
    }, async root => {
        clean(analyzeProject(root, "api"));
        await withHttp(root, async base => {
            const api = createClient<Record<string, { input: {}; output: unknown }>>(base);
            for (const endpoint of ["/empty", "/conditional"]) {
                assert.equal((await fetch(`${base}${endpoint}`)).status, 204);
                assert.equal(await api.request(`GET ${endpoint}`), undefined);
            }
            assert.deepEqual(await api.request("GET /conditional", {}, { headers: { "x-payload": "yes" } }), { ok: true });
            assert.deepEqual(await api.request("GET /imperative"), { ok: true });
            assert.equal((await fetch(`${base}/declared`)).status, 200);
            assert.deepEqual(await api.request("GET /declared"), { ok: true });
        });
    });
});

it("keeps overloaded envelopes unknown across synchronous and asynchronous branches", async () => {
    await consumer({
        "api/orders/post.ts": 'export const handler = () => ({ ok: true });',
        "api/+envelope.ts": `export function handler(ctx: { payload: { name: string } }): { wrapped: string };
            export function handler(ctx: { payload: { count: number } }): undefined;
            export function handler(ctx: { payload: { name: string } | { count: number } }) {
                return "name" in ctx.payload ? { wrapped: ctx.payload.name } : undefined;
            }`,
        "api/named/get.ts": 'import z from "zod"; export const output = z.object({ name: z.string() }); export const handler = () => ({ name: "one" });',
        "api/counted/get.ts": 'import z from "zod"; export const output = z.object({ count: z.number() }); export const handler = () => ({ count: 1 });',
        "api/plain/get.ts": 'import z from "zod"; export const envelope = false; export const output = z.object({ count: z.number() }); export const handler = () => ({ count: 1 });',
        "api/async/+envelope.ts": `export function handler(ctx: { payload: { name: string } }): Promise<{ wrapped: string }>;
            export function handler(ctx: { payload: { count: number } }): Promise<void>;
            export async function handler(ctx: { payload: { name: string } | { count: number } }): Promise<{ wrapped: string } | void> {
                return "name" in ctx.payload ? { wrapped: ctx.payload.name } : undefined;
            }`,
        "api/async/named/get.ts": 'import z from "zod"; export const output = z.object({ name: z.string() }); export const handler = () => ({ name: "one" });',
        "api/async/counted/get.ts": 'import z from "zod"; export const output = z.object({ count: z.number() }); export const handler = () => ({ count: 1 });',
        "web/client/api.ts": `import { createClient } from "@boringapi/core/client";
            import type { ApiRoutes } from "../../api/$client";
            const api = createClient<ApiRoutes>();
            async function verify() {
                // @ts-expect-error A single overload cannot describe all responses from the envelope.
                (await api.request("GET /counted")).wrapped.toUpperCase();
                // @ts-expect-error Overload selection is not inferred from individual route schemas.
                const named: { wrapped: string } = await api.request("GET /named");
                // @ts-expect-error Async overloads can retain the original payload too.
                (await api.request("GET /async/counted")).wrapped.toUpperCase();
                // @ts-expect-error Awaiting the first overload alone is not sufficient.
                const asyncNamed: { wrapped: string } = await api.request("GET /async/named");
                const plain: { count: number } = await api.request("GET /plain");
            }`,
    }, async root => {
        clean(analyzeProject(root, "api"));
        await withHttp(root, async base => {
            const api = createClient<Record<string, { input: {}; output: unknown }>>(base);
            for (const prefix of ["", "/async"]) {
                assert.deepEqual(await api.request(`GET ${prefix}/named`), { wrapped: "one" });
                assert.deepEqual(await api.request(`GET ${prefix}/counted`), { count: 1 });
            }
            assert.deepEqual(await api.request("GET /plain"), { count: 1 });
        });
    });
});

it("still rejects server dependencies and disallows runtime imports of generated contracts", () => {
    consumer({
        "web/client/bad.ts": `import { BoringApi } from "@boringapi/core";
            import { handler } from "../../api/orders/post";
            import { ApiRoutes } from "../../api/$client";
            export { BoringApi, handler };`,
    }, root => {
        const project = analyzeProject(root, "api");
        assert.equal(project.architecture.filter(error => error.code === "BORING105").length, 2);
        assert.ok(project.architecture.some(error => error.code === "BORING104"));
    });
});

it("preserves optional query fields, tuple positions and JSON input restrictions", () => {
    consumer({
        "api/tuples/post.ts": `import z from "zod";
            export const query = z.object({ tag: z.array(z.string()).optional(), limit: z.number().optional() });
            export const body = z.object({ tuple: z.tuple([z.string(), z.number().optional()]), at: z.date().optional() });
            export const output = z.object({ nested: z.array(z.object({ value: z.string().nullable() })) });
            export const handler = () => ({ nested: [] });`,
        "web/client/api.ts": `import { createClient } from "@boringapi/core/client";
            import type { ApiRoutes } from "../../api/$client";
            const api = createClient<ApiRoutes>();
            api.request("POST /tuples", { body: { tuple: ["a", 2] } });
            api.request("POST /tuples", { body: { tuple: ["a", 2] }, query: { tag: ["x"], limit: 2 } });
            // @ts-expect-error Zod tuples still require each declared position.
            api.request("POST /tuples", { body: { tuple: ["a"] } });
            // @ts-expect-error Native Date inputs cannot cross JSON; use string schemas or server-side coercion.
            api.request("POST /tuples", { body: { tuple: ["a", 2], at: new Date() } });`,
    }, root => clean(analyzeProject(root, "api")));
});

it("resolves the published browser subpath with TypeScript 4.9 and no server runtime", () => {
    consumer({}, root => {
        const packageRoot = join(root, "node_modules/@boringapi/core");
        mkdirSync(packageRoot, { recursive: true });
        writeFileSync(join(packageRoot, "package.json"), readFileSync(join(repository, "package.json")));
        const program = ts.createProgram([join(repository, "src/client.ts")], {
            target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.NodeJs,
            rootDir: join(repository, "src"), outDir: join(packageRoot, "dist"), declaration: true,
            strict: true, skipLibCheck: true, types: [],
        });
        assert.equal(ts.getPreEmitDiagnostics(program).length, 0);
        assert.equal(program.emit().emitSkipped, false);
        const configuration = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8"));
        delete configuration.compilerOptions.paths["@boringapi/core/client"];
        writeFileSync(join(root, "tsconfig.json"), JSON.stringify(configuration));
        clean(analyzeProject(root, "api"));
        const file = join(packageRoot, "dist/client.js");
        assert.doesNotMatch(readFileSync(file, "utf8"), /require\(/);
        assert.equal(typeof require(file).createClient, "function");
        assert.doesNotMatch(readFileSync(join(packageRoot, "dist/client.d.ts"), "utf8"), /\bimport\b/);
    });
});

it("uses URL parameter schema inputs before transforms and retains enum restrictions", () => {
    consumer({
        "api/kinds/[kind]/[id]/get.ts": `import z from "zod";
            export const params = z.object({ kind: z.enum(["book", "pen"]), id: z.string().transform(Number) });
            export const output = z.string(); export const handler = () => "ok";`,
        "web/client/api.ts": `import { createClient } from "@boringapi/core/client";
            import type { ApiRoutes } from "../../api/$client";
            const api = createClient<ApiRoutes>();
            api.request("GET /kinds/:kind/:id", { params: { kind: "book", id: "2" } });
            // @ts-expect-error Parameter input is a string before the numeric transformation.
            api.request("GET /kinds/:kind/:id", { params: { kind: "book", id: 2 } });
            // @ts-expect-error Parameter enum values come from the route contract.
            api.request("GET /kinds/:kind/:id", { params: { kind: "other", id: "2" } });`,
    }, root => clean(analyzeProject(root, "api")));
});

it("matches generated wire contracts to real HTTP for query arrays, envelopes, JSON slots and text", async () => {
    await consumer({
        "api/orders/post.ts": 'export const handler = () => ({ ok: true });',
        "api/query/get.ts": `import z from "zod"; import type { GetHandler } from "./$types";
            export const query = z.object({ tag: z.array(z.string().nullish()), filter: z.array(z.string()).optional() });
            export const output = query; export const handler: GetHandler = ctx => ctx.query;`,
        "api/query-shapes/get.ts": `import z from "zod";
            export const query = z.object({ tuple: z.custom<[string?]>().optional(), rest: z.tuple([]).rest(z.string()).optional(), wide: z.unknown() });
            export const handler = () => ({ ok: true });`,
        "api/conditional/get.ts": `import z from "zod";
            export const output = z.object({ id: z.string() }); export const handler = () => ({ id: "one" });`,
        "api/conditional/+envelope.ts": `import type { EnvelopeContext } from "./$types";
            export const handler = async (ctx: EnvelopeContext) => {
                if (ctx.request.header("x-mode") === "wrap") return { data: ctx.payload };
                if (ctx.request.header("x-mode") === "mutate") ctx.payload = { changed: true };
                return undefined;
            };`,
        "api/slots/get.ts": `import z from "zod";
            export const output = z.object({ array: z.array(z.string().optional()),
                tuple: z.tuple([z.string().optional(), z.string().nullable()]), absent: z.string().optional(), nil: z.null() });
            export const handler = () => ({ array: [undefined, "x"], tuple: [undefined, null], absent: undefined, nil: null });`,
        "api/null/get.ts": 'import z from "zod"; export const output = z.null(); export const handler = () => null;',
        "api/array/get.ts": 'import z from "zod"; export const output = z.array(z.string().optional()); export const handler = () => [undefined];',
        "api/omitted/get.ts": `import z from "zod";
            export const output = z.object({}).transform(() => ({ absent: undefined })); export const handler = () => ({});`,
        "api/body/post.ts": `import z from "zod"; import type { PostHandler } from "./$types";
            export const body = z.object({ array: z.array(z.string().optional()), tuple: z.tuple([z.string().optional()]),
                nullable: z.array(z.string().nullish()), absent: z.string().optional(),
                short: z.custom<[string?]>(value => Array.isArray(value) && value.length <= 1 && (value.length === 0 || typeof value[0] === "string")).optional(),
                rest: z.custom<[string?, ...number[]]>(value => Array.isArray(value) && (value.length === 0 ||
                    typeof value[0] === "string" && value.slice(1).every(entry => typeof entry === "number"))).optional() });
            export const output = body; export const handler: PostHandler = ctx => ctx.body;`,
        "api/text/[kind]/get.ts": `import z from "zod"; import type { GetHandler } from "./$types";
            export const params = z.object({ kind: z.enum(["plain", "numeric", "empty", "html", "json"]) });
            export const output = z.string(); export const handler: GetHandler = ctx => {
                if (ctx.params.kind === "json") { ctx.response.type("application/json; charset=utf-8"); return '"hello"'; }
                if (ctx.params.kind === "html") { ctx.response.type("text/html; charset=utf-8"); return "<p>hello</p>"; }
                ctx.response.type("text/plain; charset=utf-8");
                return ctx.params.kind === "numeric" ? "123" : ctx.params.kind === "empty" ? "" : "hello";
            };`,
        "web/client/api.ts": `import { createClient } from "@boringapi/core/client";
            import type { ApiRoutes } from "../../api/$client";
            const api = createClient<ApiRoutes>();
            api.request("GET /query", { query: { tag: [""] } });
            api.request("GET /query", { query: { tag: ["a", "b"], filter: undefined } });
            // @ts-expect-error Empty query arrays have no unambiguous wire representation.
            api.request("GET /query", { query: { tag: [] } });
            // @ts-expect-error Even nullable schema elements cannot cross the scalar query transport.
            api.request("GET /query", { query: { tag: [null] } });
            // @ts-expect-error Undefined is not a query array element.
            api.request("GET /query", { query: { tag: [undefined] } });
            // @ts-expect-error Optional query fields still reject an explicitly empty array.
            api.request("GET /query", { query: { tag: ["a"], filter: [] } });
            api.request("GET /query-shapes", { query: { tuple: ["a"], rest: ["b"], wide: ["c"] as [string] } });
            // @ts-expect-error A tuple with only optional positions cannot bypass the transport limit.
            api.request("GET /query-shapes", { query: { tuple: [] } });
            // @ts-expect-error Neither can a rest-only tuple.
            api.request("GET /query-shapes", { query: { rest: [] } });
            // @ts-expect-error Broad schema inputs still obey transport constraints.
            api.request("GET /query-shapes", { query: { wide: [] } });
            api.request("POST /body", { body: { array: ["x"], tuple: ["y"], nullable: [null], absent: undefined } });
            // @ts-expect-error Undefined array slots become null, which this input schema rejects.
            api.request("POST /body", { body: { array: [undefined], tuple: ["y"], nullable: [] } });
            // @ts-expect-error Undefined tuple slots become null too.
            api.request("POST /body", { body: { array: [], tuple: [undefined], nullable: [] } });
            // @ts-expect-error Do not pretend the input schema accepts null after removing undefined.
            api.request("POST /body", { body: { array: [null], tuple: ["y"], nullable: [] } });
            api.request("POST /body", { body: { array: [], tuple: ["y"], nullable: [], short: [] } });
            api.request("POST /body", { body: { array: [], tuple: ["y"], nullable: [], short: ["z"] } });
            // @ts-expect-error Optional tuple positions may be absent, but explicit undefined becomes null.
            api.request("POST /body", { body: { array: [], tuple: ["y"], nullable: [], short: [undefined] } });
            api.request("POST /body", { body: { array: [], tuple: ["y"], nullable: [], rest: [] } });
            api.request("POST /body", { body: { array: [], tuple: ["y"], nullable: [], rest: ["z", 1, 2] } });
            // @ts-expect-error A rest element cannot fill the optional leading string position.
            api.request("POST /body", { body: { array: [], tuple: ["y"], nullable: [], rest: [1] } });
            // @ts-expect-error Omitting an optional leading slot via undefined would encode null.
            api.request("POST /body", { body: { array: [], tuple: ["y"], nullable: [], rest: [undefined, 1] } });
            async function verify() {
                const result = await api.request("GET /slots");
                const array: Array<string | null> = result.array;
                const tuple: [string | null, string | null] = result.tuple;
                const absent: string | undefined = result.absent;
                const nil: null = result.nil;
                // @ts-expect-error Output array slots can contain null, not undefined.
                const wrongArray: Array<string | undefined> = result.array;
                // @ts-expect-error Output tuple slots can contain null, not undefined.
                const wrongTuple: [string | undefined, string | null] = result.tuple;
                const empty: undefined = await api.request("GET /null");
                const topArray: Array<string | null> = await api.request("GET /array");
                const omitted: ApiRoutes["GET /omitted"]["output"] = {};
                // @ts-expect-error A top-level null is sent as an empty Express response.
                const wrongNull: null = await api.request("GET /null");
                const conditional: unknown = await api.request("GET /conditional");
                // @ts-expect-error The undefined envelope branch may retain or mutate the payload.
                const unsafe: { data: { id: string } } | undefined = await api.request("GET /conditional");
            }`,
    }, async root => {
        clean(analyzeProject(root, "api"));
        symlinkSync(join(repository, "node_modules"), join(root, "node_modules"), "dir");
        const unregister = registerTypeScript(join(root, "api"));
        let server: import("node:http").Server | undefined;
        try {
            const app = await new BoringApi().createApp(join(root, "api"));
            server = await new Promise<import("node:http").Server>((resolve, reject) => {
                const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
                listening.once("error", reject);
            });
            const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
            let fetched = 0;
            const api = createClient<Record<string, { input: Record<string, unknown>; output: unknown }>>(base, {
                fetch: (...args) => { fetched++; return fetch(...args); },
            });
            for (const tag of [[""], ["x"], ["x&y", "z"]]) {
                assert.deepEqual(await api.request("GET /query", { query: { tag, filter: undefined } }), { tag });
            }
            const before = fetched;
            await assert.rejects(api.request("GET /query", { query: { tag: [] } }), /at least one value/);
            assert.equal(fetched, before, "empty arrays fail before any HTTP request");
            assert.deepEqual(await api.request("GET /conditional"), { id: "one" });
            assert.deepEqual(await api.request("GET /conditional", {}, { headers: { "x-mode": "wrap" } }), { data: { id: "one" } });
            assert.deepEqual(await api.request("GET /conditional", {}, { headers: { "x-mode": "mutate" } }), { changed: true });
            assert.deepEqual(await api.request("GET /slots"), { array: [null, "x"], tuple: [null, null], nil: null });
            assert.equal(await api.request("GET /null"), undefined);
            assert.deepEqual(await api.request("GET /array"), [null]);
            assert.deepEqual(await api.request("GET /omitted"), {});
            assert.deepEqual(await api.request("POST /body", { body: { array: ["x"], tuple: ["y"], nullable: [null], absent: undefined } }),
                { array: ["x"], tuple: ["y"], nullable: [null] });
            for (const short of [[], ["z"]]) {
                const body = { array: [], tuple: ["y"], nullable: [], short };
                assert.deepEqual(await api.request("POST /body", { body }), body);
            }
            for (const rest of [[], ["z", 1, 2]]) {
                const body = { array: [], tuple: ["y"], nullable: [], rest };
                assert.deepEqual(await api.request("POST /body", { body }), body);
            }
            for (const body of [{ array: [undefined], tuple: ["y"], nullable: [] }, { array: [], tuple: [undefined], nullable: [] },
                { array: [], tuple: ["y"], nullable: [], short: [undefined] }]) {
                await assert.rejects(api.request("POST /body", { body }), error => error instanceof ApiError && error.status === 400);
            }
            for (const [kind, expected] of [["plain", "hello"], ["numeric", "123"], ["empty", ""], ["html", "<p>hello</p>"], ["json", "hello"]]) {
                assert.equal(await api.request("GET /text/:kind", { params: { kind } }), expected);
            }
        } finally {
            if (server) await new Promise<void>((resolve, reject) => {
                server!.close(error => error ? reject(error) : resolve()); server!.closeAllConnections();
            });
            unregister();
        }
    });
});
