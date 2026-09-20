import { formatHost } from "@boringapi/compiler";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import ts from "typescript";
import { BoringApi } from "@boringapi/core";
import { generateTypes } from "@boringapi/typegen";
import { scanApi } from "@boringapi/core/conventions";
import { formatInspection, inspectProject, Inspection } from "../src";
import { analyzeProject } from "../src";

const repository = process.cwd();
function write(root: string, file: string, text: string) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
}
function project(files: Record<string, string>, run: (root: string) => void | Promise<void>) {
    const root = mkdtempSync(join(tmpdir(), "boring-inspect-"));
    let pending = false;
    try {
        write(root, "package.json", '{"name":"inspect-consumer","private":true}');
        write(root, "tsconfig.json", JSON.stringify({ compilerOptions: {
            target: "ES2020", module: "commonjs", moduleResolution: "node", esModuleInterop: true,
            strict: true, skipLibCheck: true, allowJs: true, baseUrl: ".",
            paths: { "@boringapi/core": [require.resolve("@boringapi/core").replace(/\.js$/, ".d.ts")],
                zod: [join(repository, "node_modules/zod")], "@orders/*": ["modules/orders/*"] },
        }, include: ["api/**/*"] }));
        for (const [file, text] of Object.entries(files)) write(root, file, text);
        const result = run(root);
        if (result) { pending = true; return result.finally(() => rmSync(root, { recursive: true, force: true })); }
    } finally { if (!pending) rmSync(root, { recursive: true, force: true }); }
}
function inspect(root: string, directory = "api") {
    const analyzed = analyzeProject(root, directory);
    assert.equal(analyzed.diagnostics.length, 0, ts.formatDiagnostics(analyzed.diagnostics, formatHost(root)));
    assert.deepEqual(analyzed.architecture.map(error => error.message), []);
    return inspectProject(analyzed);
}

it("follows aliases and re-exports without executing setup, routes, schemas or facades, and refreshes signatures", () => {
    project({
        "api/+setup.ts": 'import { makeOrders, identity } from "@orders/facade"; throw new Error("EXECUTED setup"); export async function setup() { return { sales: makeOrders(), identity }; }',
        "api/get.ts": 'import { parsed } from "../modules/orders/schemas"; throw new Error("EXECUTED route"); export const query = parsed; export const output = parsed; export const handler = () => "1";',
        "modules/orders/facade.ts": 'export { makeOrders, identity } from "./facade/operations"; throw new Error("EXECUTED facade");',
        "modules/orders/facade/operations.ts": [
            '/** Retrieve an existing order. */',
            'export function get(id: string): string;',
            'export function get(id: number): number;',
            'export function get(id: string | number) { return id; }',
            'export function makeOrders() { return { get }; }',
            'export function identity<T extends string | number = string>(value: T): T { return value; }',
        ].join("\n"),
        "modules/orders/schemas.ts": 'import { z } from "zod"; export const parsed = z.string().transform(value => value.length); export type Parsed = z.output<typeof parsed>; throw new Error("EXECUTED schema");',
        "modules/unused/facade.ts": 'export const existing = (name: string) => name; throw new Error("EXECUTED unused");',
    }, root => {
        const first = inspect(root);
        assert.equal(JSON.stringify(inspect(root)), JSON.stringify(first));
        const operation = first.services.find(service => service.name === "sales")!.operations[0];
        assert.equal(operation.access, "ctx.services.sales.get");
        assert.equal(operation.source.file, "modules/orders/facade/operations.ts");
        assert.equal(operation.source.line, 4);
        assert.deepEqual(operation.signatures.map(signature => signature.returnType), ["string", "number"]);
        const identity = first.services.find(service => service.name === "identity")!.operations[0];
        assert.equal(identity.access, "ctx.services.identity");
        assert.equal(identity.source.file, "modules/orders/facade/operations.ts");
        assert.deepEqual(identity.signatures[0].typeParameters, ["T extends string | number = string"]);
        assert.equal(first.routes[0].input.query!.inputType, "string");
        assert.equal(first.routes[0].input.query!.outputType, "number");
        assert.equal(first.routes[0].output!.outputType, "number");
        assert.equal(first.modules.find(module => module.name === "unused")!.facade!.exports[0].name, "existing");
        assert.equal(first.modules.find(module => module.name === "orders")!.facade!.exports[0].source.file, "modules/orders/facade/operations.ts");
        write(root, "modules/unused/facade.ts", '\n/** Now accepts a numeric id. */\nexport const existing = (id: number) => ({ id });');
        const updated = inspect(root).modules.find(module => module.name === "unused")!.facade!.exports[0];
        assert.equal(updated.source.line, 3);
        assert.equal(updated.signatures[0].parameters[0].type, "number");
        assert.match(updated.signatures[0].returnType, /id: number/);
        assert.match(updated.description, /numeric id/);
    });
});

it("keeps type-only exports distinct from runtime operations through aliases and barrels", () => {
    project({
        "api/get.ts": 'export const handler = () => null;',
        "modules/orders/facade/operations.ts": 'export const run = (id: string) => id; export interface Order { id: string; }',
        "modules/orders/facade/types.ts": 'export type { run as throughBarrel } from "./operations";',
        "modules/orders/facade.ts": [
            'export type { run as declared, Order } from "./facade/operations";',
            'export { type run as inline, run as publicRun } from "./facade/operations";',
            'import type { run as imported } from "./facade/operations";',
            'export { imported };',
            'export { throughBarrel as renamed } from "./facade/types";',
            'export * from "./facade/types";',
        ].join("\n"),
    }, root => {
        const result = inspect(root);
        const entries = result.modules[0].facade!.exports;
        for (const name of ["declared", "inline", "imported", "renamed", "throughBarrel", "Order"]) {
            const entry = entries.find(entry => entry.name === name)!;
            assert.equal(entry.kind, "type", name);
            assert.deepEqual(entry.signatures, [], name);
            assert.equal(entry.schema, null, name);
            assert.equal(entry.source.file, "modules/orders/facade/operations.ts");
        }
        assert.match(entries.find(entry => entry.name === "declared")!.type!, /string/);
        assert.equal(entries.find(entry => entry.name === "publicRun")!.kind, "function");
        assert.match(formatInspection(result), /type declared:/);
    });
});

it("discovers composed services and only the shared callable operations of union services", () => {
    project({
        "api/+setup.ts": 'import { makeCombined, makeVariant } from "../modules/orders/facade"; export const setup = () => ({ combined: makeCombined(), variant: makeVariant(true), label: "orders", absent: undefined });',
        "api/get.ts": 'import type { GetHandler } from "./$types"; export const handler: GetHandler = ctx => [ctx.services.combined.get("1"), ctx.services.combined.create(), ctx.services.variant.get("2")];',
        "modules/orders/facade.ts": [
            'export const makeCombined = () => ({ get(id: string) { return id; }, create() { return "new"; } });',
            'type Variant = { get(id: string): string; create(): string } | { get(id: string): string; remove(id: string): void };',
            'export function makeVariant(create: boolean): Variant { return create ? { get: id => id, create: () => "new" } : { get: id => id, remove() {} }; }',
        ].join("\n"),
    }, root => {
        const result = inspect(root);
        assert.deepEqual(result.services.map(service => service.name), ["combined", "variant"]);
        assert.deepEqual(result.services[0].operations.map(operation => operation.access), ["ctx.services.combined.create", "ctx.services.combined.get"]);
        assert.deepEqual(result.services[1].operations.map(operation => operation.access), ["ctx.services.variant.get"]);
        for (const service of result.services) {
            const signature = service.operations.find(operation => operation.name === "get")!.signatures[0];
            assert.equal(signature.parameters[0].type, "string");
            assert.equal(signature.returnType, "string");
        }
        assert.match(formatInspection(result), /ctx.services.combined.get\(id: string\)/);
    });
});

it("rejects class instances and dynamic composition at the public boundary", () => {
    project({
        "api/+setup.ts": 'import { make } from "../modules/orders/facade"; export const setup = () => ({ orders: make() });',
        "api/get.ts": 'export const handler = () => null;',
        "modules/orders/facade.ts": 'class Orders { get() { return "1"; } } export const make = () => new Orders(); export const dynamic = () => Object.assign({}, new Orders());',
    }, root => {
        const analyzed = analyzeProject(root, "api");
        assert.ok(analyzed.architecture.some(error => error.code === "BORING112"));
        assert.ok(analyzed.architecture.some(error => error.code === "BORING113"));
        assert.throws(() => inspectProject(analyzed), /Cannot inspect/);
    });
});

it("instantiates generic method constraints and defaults while preserving dependent type parameters", () => {
    project({
        "api/+setup.ts": 'import { make } from "../modules/orders/facade"; export const setup = () => ({ orders: make<string>() });',
        "api/get.ts": 'import type { GetHandler } from "./$types"; export const handler: GetHandler = ctx => ctx.services.orders.get("1");',
        "modules/orders/facade.ts": [
            'export function make<T extends string | number>() { return {',
            '    get<U extends T = T>(id: U): U { return id; },',
            '    pair<U extends T, V extends U = U>(first: U, second: V): [U, V] { return [first, second]; },',
            '}; }',
        ].join("\n"),
    }, root => {
        const result = inspect(root);
        const operations = result.services[0].operations;
        assert.deepEqual(operations.find(operation => operation.name === "get")!.signatures[0].typeParameters, ["U extends string = string"]);
        const pair = operations.find(operation => operation.name === "pair")!.signatures[0];
        assert.deepEqual(pair.typeParameters, ["U extends string", "V extends U = U"]);
        assert.deepEqual(pair.parameters.map(parameter => parameter.type), ["U", "V"]);
        assert.equal(pair.returnType, "[U, V]");
        assert.match(formatInspection(result), /ctx.services.orders.get<U extends string = string>\(id: U\): U/);
        assert.deepEqual(result.modules[0].facade!.exports[0].signatures[0].typeParameters, ["T extends string | number"]);
    });
});

it("distinguishes declaration literals, undefined and runtime expressions without evaluating rules", () => {
    project({
        "api/+auth.ts": 'export const authenticate = () => ({ kind: "user" as const, id: "user", permissions: [] }); export function authorize(_ctx: unknown, _rule: unknown) {} throw new Error("EXECUTED auth");',
        "modules/access/schemas.ts": 'export const read = "orders:read"; const allOf = [read] as const; export const rule = { allOf } as const;',
        "api/static/get.ts": 'import { rule } from "../../modules/access/schemas"; export const authorization = rule; export const handler = () => null;',
        "api/dynamic/get.ts": 'function choose(): string { throw new Error("EXECUTED rule"); } export const authorization = choose(); export const envelope = Boolean(1); export const handler = () => null;',
        "api/absent/get.ts": 'export const authorization = undefined; export const authentication = false; export const handler = () => null;',
        "api/mutable/get.ts": 'export let authentication = false; authentication = true; export const handler = () => null;',
    }, root => {
        // A recursive declaration is intentionally invalid at runtime but still must not hang inspection.
        const analyzed = analyzeProject(root, "api");
        const result = inspectProject(analyzed);
        const route = (path: string) => result.routes.find(route => route.path === path)!;
        const rule = route("/static").access.authorization!;
        assert.equal(rule.kind, "literal");
        if (rule.kind === "literal") assert.deepEqual(rule.value, { allOf: ["orders:read"] });
        assert.equal(route("/static").access.session, "required");
        assert.equal(route("/dynamic").access.authorization!.kind, "expression");
        assert.equal(route("/dynamic").access.session, "conditional");
        assert.equal(route("/dynamic").hooks.envelope.enabled, "conditional");
        assert.equal(route("/absent").access.authorization!.kind, "undefined");
        assert.equal(route("/absent").access.session, "optional");
        assert.equal(route("/mutable").access.authentication!.kind, "expression");
    });
});

it("uses the runtime precedence for middleware, envelopes and nearest error fallbacks, including CommonJS", () => {
    project({
        "api/+middleware.js": 'exports.handler = () => ({ root: true });',
        "api/+envelope.js": 'exports.handler = () => "root";',
        "api/+error.404.js": 'exports.handler = () => "root404";',
        "api/+error.503.js": 'exports.handler = () => "root503";',
        "api/+auth.js": 'exports.authenticate = () => ({ kind: /** @type {const} */ ("user"), id: "user", permissions: [] }); exports.authorize = () => {};',
        "api/+setup.ts": 'import { make } from "../modules/orders/facade"; export const setup = () => ({ orders: make() });',
        "modules/orders/facade.ts": 'export { make } from "./facade/operations";',
        "modules/orders/facade/operations.ts": 'export const make = () => ({ get(id: string) { return id; } });',
        "api/scoped/+middleware.js": 'exports.handler = () => ({ child: true });',
        "api/scoped/+envelope.js": 'exports.handler = () => "scoped";',
        "api/scoped/+error.js": 'exports.handler = () => "scopedError";',
        "api/scoped/get.js": 'exports.authorization = "read"; exports.envelope = false; exports.handler = () => null;',
        "api/scoped/child/+error.500.js": 'exports.handler = () => "child500";',
        "api/scoped/child/get.js": 'const authorization = "child"; module.exports = { authorization, handler: () => null };',
    }, root => {
        const result = inspect(root);
        const scoped = result.routes.find(route => route.path === "/scoped")!;
        assert.equal(scoped.access.session, "required");
        assert.equal(scoped.hooks.envelope.enabled, false);
        assert.equal(scoped.hooks.envelope.source!.file, "api/scoped/+envelope.js");
        assert.deepEqual(scoped.hooks.middleware.map(source => source.file), ["api/+middleware.js", "api/scoped/+middleware.js"]);
        assert.equal(scoped.hooks.errors.statuses["404"]!.file, "api/scoped/+error.js");
        assert.equal(scoped.hooks.errors.statuses["503"]!.file, "api/scoped/+error.js");
        assert.equal(result.routes.find(route => route.path === "/scoped/child")!.hooks.errors.statuses["503"]!.file, "api/scoped/child/+error.500.js");
        assert.equal(result.routes.find(route => route.path === "/scoped/child")!.access.session, "required");
        assert.equal(result.unmatchedErrors.statuses["404"]!.file, "api/+error.404.js");
        assert.equal(result.services[0].operations[0].access, "ctx.services.orders.get");
    });
});


it("shares route precedence between type generation, inspection and startup", async () => {
    await project({
        "api/[id]/get.js": 'exports.handler = () => "dynamic";',
        "api/latest/get.js": 'exports.handler = () => "get";',
        "api/latest/head.js": 'exports.handler = () => "head";',
    }, async root => {
        const expected = ["HEAD /latest", "GET /latest", "GET /:id"];
        const app = await new BoringApi().createApp(join(root, "api"));
        const runtime = app.http._router.stack.filter((layer: any) => layer.route)
            .map((layer: any) => `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`);
        assert.deepEqual(runtime, expected);
        assert.deepEqual(inspect(root).routes.map(route => `${route.method} ${route.path}`), expected);
        for (const routes of [scanApi(join(root, "api")).routes, generateTypes(root, "api").sources.routes]) {
            assert.deepEqual(routes.map(route => `${route.method.toUpperCase()} ${route.path}`), expected);
        }
    });
});

it("rejects structural mistakes consistently before startup executes any modules", async () => {
    const cases: [Record<string, string>, RegExp][] = [
        [{ "get.ts": 'export const handler = () => null;', "get.js": 'exports.handler = () => null;' }, /Duplicate source files/],
        [{ "nested/+auth.js": '' }, /only allowed at the API root/],
        [{ "+error.200.js": '' }, /Unknown convention file/],
        [{ "helpers.js": '' }, /Unsupported endpoint file/],
        [{ "[one]/get.js": '', "[two]/get.js": '' }, /Duplicate route/],
    ];
    for (const [files, expected] of cases) {
        const root = mkdtempSync(join(tmpdir(), "boring-inspect-invalid-"));
        try {
            write(root, "api/+setup.js", 'throw new Error("EXECUTED before structural validation");');
            for (const [file, text] of Object.entries(files)) write(root, `api/${file}`, text);
            assert.throws(() => analyzeProject(root, "api"), expected);
            await assert.rejects(() => new BoringApi().createApp(join(root, "api")), expected);
        } finally { rmSync(root, { recursive: true, force: true }); }
    }
});
