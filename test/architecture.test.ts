import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import ts from "typescript";
import { BoringApi, generateTypes } from "../src";
import { architectureFiles, checkArchitecture, formatArchitectureDiagnostics } from "../src/core/architecture";

const repository = join(__dirname, "..");

function project(files: Record<string, string>, run: (root: string) => void): void {
    const root = mkdtempSync(join(tmpdir(), "boring-architecture-"));
    try {
        for (const [name, text] of Object.entries({
            "package.json": '{"name":"architecture-consumer","private":true}',
            "api/get.ts": "export const handler = () => null;",
            ...files,
        })) {
            const file = join(root, name);
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, text);
        }
        run(root);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

function inspect(root: string, compilerOptions: ts.CompilerOptions = {}) {
    const options: ts.CompilerOptions = {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
        moduleResolution: ts.ModuleResolutionKind.NodeJs,
        jsx: ts.JsxEmit.Preserve,
        strict: true, noEmit: true, allowJs: true, skipLibCheck: true,
        esModuleInterop: true, baseUrl: root,
        paths: {
            "@boringapi/core": [join(repository, "src/index.ts")],
            zod: [join(repository, "node_modules/zod")],
            "@app/*": ["*"],
        },
        ...compilerOptions,
    };
    const program = ts.createProgram(architectureFiles(join(root, "api")), options);
    return {
        program,
        diagnostics: checkArchitecture(program, join(root, "api"), join(root, ".boring/types")),
    };
}

const sdk = {
    "node_modules/database-sdk/package.json": '{"name":"database-sdk","version":"1.0.0","types":"index.d.ts"}',
    "node_modules/database-sdk/index.d.ts": "export function query(): string;",
};

it("allows public facades, private implementations, schema sharing and injected adapters without executing code", () => {
    project({
        "api/+setup.ts": [
            'import { createOrders } from "../modules/orders/facade";',
            'import { store } from "../infra/store";',
            'export async function setup() { return { orders: createOrders(store), name: "demo" }; }',
        ].join("\n"),
        "api/+auth.ts": [
            'import { check } from "../modules/access/facade";',
            'export function authorize() { check(); }',
        ].join("\n"),
        "api/get.ts": 'import { order } from "../modules/orders/schemas"; export const output = order; export const handler = () => "ok";',
        "modules/orders/schemas.ts": 'import z from "zod"; export const order = z.string();',
        "modules/access/schemas.ts": 'import type { PermissionRule } from "@boringapi/core"; export type Rule = PermissionRule<"orders:read">;',
        "modules/access/facade.ts": 'export function check() {}',
        "modules/orders/facade.ts": [
            'import { check } from "../access/facade";',
            'import { writeFileSync } from "fs";',
            'import { join } from "path";',
            'writeFileSync(join(__dirname, "EXECUTED"), "must not happen");',
            'export { label } from "./internal/operation";',
            'export interface Store { read(): string; }',
            'export function createOrders(store: Store) { return { get() { check(); return store.read(); } }; }',
        ].join("\n"),
        "modules/orders/internal/operation.ts": 'export const label = "public through facade";',
        "infra/store.ts": 'import type { Store } from "../modules/orders/facade"; export const store: Store = { read: () => "ok" };',
        "web/client/page.tsx": 'import { order } from "../../modules/orders/schemas"; export const example = order.parse("ok");',
    }, root => {
        const result = inspect(root);
        assert.deepEqual(result.diagnostics, []);
        assert.equal(ts.getPreEmitDiagnostics(result.program).length, 0);
        assert.equal(existsSync(join(root, "modules/orders/EXECUTED")), false);
    });
});

it("rejects direct, aliased and CommonJS infrastructure/SDK imports in endpoints with actionable locations", () => {
    project({
        ...sdk,
        "api/direct/get.ts": 'import { query } from "../../infra/db"; export const handler = query;',
        "api/alias/get.ts": 'import { query } from "@app/infra/db"; export const handler = query;',
        "api/sdk/get.ts": 'import { query } from "database-sdk"; export const handler = query;',
        "api/require/get.js": 'const db = require("../../infra/db"); exports.handler = db.query;',
        "api/import-equals/get.ts": 'import db = require("../../infra/db"); export const handler = db.query;',
        "api/lazy/get.ts": 'export const handler = async () => (await import("../../infra/db")).query();',
        "api/builtin/get.ts": 'import { readFileSync } from "node:fs"; export const handler = () => readFileSync("data");',
        "api/factory/get.ts": 'import { createOrders } from "../../modules/orders/facade"; export const handler = createOrders;',
        "api/+setup.ts": 'import { createOrders } from "../modules/orders/facade"; export async function setup() { return { orders: createOrders(), name: "demo" }; }',
        "modules/orders/facade.ts": 'export function createOrders() { return { get() { return "order"; } }; }',
        "infra/db.ts": 'export function query() { return "order"; }',
    }, root => {
        const { diagnostics } = inspect(root);
        assert.equal(diagnostics.length, 8);
        assert.ok(diagnostics.every(diagnostic => diagnostic.code === "BORING101"));
        const text = formatArchitectureDiagnostics(diagnostics, root);
        assert.match(text, /api[/\\]alias[/\\]get.ts:1:\d+ - error BORING101/);
        assert.match(text, /ctx\.services\.orders\.get \(modules[/\\]orders[/\\]facade.ts:1\)/);
        assert.ok(!text.includes("ctx.services.name."), text);
    });
});

it("rejects foreign internals through aliases, re-exports and type imports while permitting a facade's own re-exports", () => {
    project({
        "modules/orders/facade.ts": 'export { secret as publicOperation } from "./internal/store";',
        "modules/orders/internal/store.ts": 'export const secret = 1; export type Record = { id: string };',
        "modules/billing/facade.ts": 'export { secret } from "@app/modules/orders/internal/store";',
        "modules/billing/internal/types.ts": 'import type { Record } from "../../orders/internal/store"; export type Copy = Record;',
        "api/get.ts": 'import { secret } from "../modules/billing/facade"; export const handler = () => secret;',
    }, root => {
        const { diagnostics } = inspect(root);
        assert.deepEqual(diagnostics.map(diagnostic => diagnostic.code).sort(), ["BORING101", "BORING102", "BORING102"]);
        assert.ok(!diagnostics.some(diagnostic => diagnostic.file.fileName === join(root, "modules/orders/facade.ts")));
    });
});

it("uses real paths so a facade-shaped symlink cannot expose another module's internals", () => {
    project({
        "api/get.ts": 'import { value } from "../modules/alias/facade"; export const handler = () => value;',
        "modules/orders/internal/store.ts": 'export const value = 1;',
    }, root => {
        mkdirSync(join(root, "modules/alias"));
        symlinkSync(join(root, "modules/orders/internal/store.ts"), join(root, "modules/alias/facade.ts"));
        const { diagnostics } = inspect(root, { preserveSymlinks: true });
        assert.ok(diagnostics.some(diagnostic => diagnostic.code === "BORING102"));
    });
});

it("recognizes workspace package dependencies without treating package-shaped local aliases as trusted", () => {
    project({
        "packages/sdk/package.json": '{"name":"workspace-sdk","version":"1.0.0","types":"index.d.ts"}',
        "packages/sdk/index.d.ts": 'export function query(): string;',
        "modules/orders/facade.ts": 'import { query } from "workspace-sdk"; export const read = query;',
        "api/sdk/get.ts": 'import { query } from "workspace-sdk"; export const handler = query;',
        "api/disguised/get.ts": 'import { query } from "zod"; export const handler = query;',
        "infra/db.ts": 'export const query = () => "data";',
    }, root => {
        mkdirSync(join(root, "node_modules"));
        symlinkSync(join(root, "packages/sdk"), join(root, "node_modules/workspace-sdk"), "dir");
        const { diagnostics } = inspect(root, { paths: { zod: ["infra/db.ts"] } });
        assert.equal(diagnostics.length, 2);
        assert.ok(diagnostics.every(diagnostic => diagnostic.code === "BORING101"));
    });
});

it("finds runtime module cycles through private files and aliases but permits type-only cycles", () => {
    project({
        "modules/orders/facade.ts": 'export * from "./internal/operation";',
        "modules/orders/internal/operation.ts": 'import { charge } from "@app/modules/billing/facade"; export const create = () => charge();',
        "modules/billing/facade.ts": 'import { create } from "../orders/facade"; export const charge = (): unknown => create;',
        "modules/a/schemas.ts": 'import type { B } from "../b/schemas"; export type A = { b?: B };',
        "modules/b/schemas.ts": 'import type { A } from "../a/schemas"; export type B = { a?: A };',
    }, root => {
        const { diagnostics } = inspect(root);
        assert.equal(diagnostics.length, 1);
        assert.equal(diagnostics[0].code, "BORING103");
        assert.match(diagnostics[0].message, /billing -> orders -> billing/);
    });
});

it("tracks module cycles across infrastructure dependencies", () => {
    project({
        "modules/a/facade.ts": 'import { value } from "../../infra/adapter"; export const read = () => value;',
        "modules/a/schemas.ts": 'export const value = 1;',
        "infra/adapter.ts": 'export { value } from "../modules/b/schemas";',
        "modules/b/schemas.ts": 'export { value } from "../a/schemas";',
    }, root => {
        assert.ok(inspect(root).diagnostics.some(diagnostic => diagnostic.code === "BORING103"));
    });
});

it("rejects reverse dependencies on entry points and infrastructure calls to facades", () => {
    project({
        "api/+setup.ts": 'export const setup = () => ({});',
        "api/get.ts": 'import { setup } from "./+setup"; export const handler = setup;',
        "modules/orders/facade.ts": 'import { handler } from "../../api/get"; export const call = handler;',
        "infra/backwards.ts": 'export { handler } from "../api/get";',
        "infra/service.ts": 'import { call } from "../modules/orders/facade"; export const query = call;',
    }, root => {
        const { diagnostics } = inspect(root);
        assert.equal(diagnostics.filter(diagnostic => diagnostic.code === "BORING104").length, 4);
    });
});

it("keeps browser code and shared schemas independent of local server code and Node builtins", () => {
    project({
        ...sdk,
        "modules/orders/facade.ts": 'export const secret = 1;',
        "modules/orders/schemas.ts": 'export { secret } from "./facade";',
        "modules/sdk/schemas.ts": 'export { query } from "database-sdk";',
        "infra/db.ts": 'export const db = 1;',
        "web/client/db.ts": 'export { db } from "../../infra/db";',
        "web/client/node.ts": 'export { readFileSync } from "node:fs";',
        "web/client/core.ts": 'export { BoringApi } from "@boringapi/core";',
        "web/client/type.ts": 'import type { secret } from "../../modules/orders/facade"; export type Server = typeof secret;',
        "web/client/barrel.ts": 'export * from "./db";',
    }, root => {
        const { diagnostics } = inspect(root);
        assert.equal(diagnostics.filter(diagnostic => diagnostic.code === "BORING105").length, 6);
    });
});

it("checks unused server pages and only permits setup to wire their presentation adapters", () => {
    project({
        ...sdk,
        "api/+setup.ts": 'import { createPages } from "../web/server/pages"; export const setup = () => ({ pages: createPages() });',
        "modules/orders/facade.ts": 'export const get = () => "order";',
        "modules/orders/schemas.ts": 'export type Order = string;',
        "web/server/pages.ts": 'import { get } from "../../modules/orders/facade"; export const createPages = () => ({ order: get });',
        "web/server/unused.ts": 'import { query } from "database-sdk"; export const leak = query;',
        "web/server/storage.ts": 'import { db } from "../../infra/db"; export const leak = db;',
        "infra/db.ts": 'export const db = {};',
        "modules/backwards/facade.ts": 'export { createPages } from "../../web/server/pages";',
        "web/client/server.ts": 'export { createPages } from "../server/pages";',
    }, root => {
        const { diagnostics } = inspect(root);
        assert.equal(diagnostics.filter(diagnostic => diagnostic.code === "BORING109").length, 3);
        assert.equal(diagnostics.filter(diagnostic => diagnostic.code === "BORING105").length, 1);
        assert.equal(diagnostics.length, 4);
    });
});

it("rejects computed imports, aliased loaders, unresolved JS requires and custom loaders", () => {
    project({
        "modules/orders/facade.ts": [
            'const path = "../../infra/db";',
            'export const dynamic = () => import(path);',
            'export const commonjs = () => require(path);',
            'const load = require;',
            'export const alias = () => load(path);',
            'export const moduleLoad = () => module.require(path);',
            'export const resolveOnly = () => require.resolve(path);',
        ].join("\n"),
        "infra/custom.ts": 'import { createRequire } from "node:module"; export const load = createRequire(__filename);',
        "infra/missing.js": 'exports.db = require("missing-database-package");',
    }, root => {
        const { diagnostics } = inspect(root);
        assert.equal(diagnostics.length, 7);
        assert.ok(diagnostics.every(diagnostic => diagnostic.code === "BORING106"));
    });
});

it("checks literal dynamic imports and CommonJS barrels even when TypeScript did not load their targets", () => {
    project({
        "modules/orders/facade.ts": 'const store = require("./internal/barrel"); export const read = () => store.value;',
        "modules/orders/internal/barrel.ts": 'export { value } from "../../billing/internal/store";',
        "modules/billing/internal/store.ts": 'export const value = 1;',
        "infra/lazy.ts": 'export const read = async () => (await import("./db")).value;',
        "infra/db.ts": 'export const value = 1;',
    }, root => {
        // Deliberately leave the require target out of rootNames to exercise graph expansion.
        const { program } = inspect(root);
        const partial = ts.createProgram([join(root, "modules/orders/facade.ts"), join(root, "infra/lazy.ts")], program.getCompilerOptions());
        const diagnostics = checkArchitecture(partial, join(root, "api"), join(root, ".boring/types"));
        assert.equal(diagnostics.filter(diagnostic => diagnostic.code === "BORING102").length, 1);
        assert.ok(!diagnostics.some(diagnostic => diagnostic.code === "BORING106"));
    });
});

it("does not allow unclassified helpers or misplaced module files to bypass the structure", () => {
    project({
        "api/get.ts": 'import { db } from "../helpers"; export const handler = () => db;',
        "helpers.ts": 'export { db } from "./infra/db";',
        "infra/db.ts": 'export const db = 1;',
        "modules/orders/facade.ts": 'export { db } from "../../helpers";',
        "modules/misplaced.ts": 'export const value = 1;',
    }, root => {
        const { diagnostics } = inspect(root);
        assert.equal(diagnostics.filter(diagnostic => diagnostic.code === "BORING101").length, 1);
        assert.equal(diagnostics.filter(diagnostic => diagnostic.code === "BORING107").length, 2);
    });
});

it("boring check enforces architecture, includes unused modules, and has no opt-out", () => {
    project({
        "infra/db.js": 'exports.query = () => null;',
        "api/get.js": 'exports.handler = () => null;',
        "modules/unused/facade.ts": 'import { handler } from "../../api/get"; export const run = handler;',
    }, root => {
        rmSync(join(root, "api/get.ts"));
        const run = (args: string[] = []) => spawnSync(process.execPath, [
            "-r", require.resolve("ts-node/register"), join(repository, "src/cli.ts"), "check", "api", ...args,
        ], { cwd: root, encoding: "utf8", env: { ...process.env, TS_NODE_PROJECT: join(repository, "tsconfig.json") } });
        const result = run();
        assert.equal(result.status, 1);
        assert.match(`${result.stdout}\n${result.stderr}`, /modules[/\\]unused[/\\]facade.ts:1:\d+ - error BORING104/);
        const disabled = run(["--no-architecture"]);
        assert.equal(disabled.status, 1);
        assert.match(disabled.stderr, /Unknown option/);
    });
});

it("startup and check reject prototype folder names using the ordinary URL convention", async () => {
    for (const name of ["_base", "_setup"]) {
        const root = mkdtempSync(join(tmpdir(), "boring-invalid-folder-"));
        try {
            mkdirSync(join(root, "api", name), { recursive: true });
            writeFileSync(join(root, "api", name, "get.js"), "exports.handler = () => null;");
            assert.throws(() => generateTypes(root, "api"), /Invalid endpoint directory/);
            await assert.rejects(() => new BoringApi().createApp(join(root, "api")), /Invalid endpoint directory/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }
});
