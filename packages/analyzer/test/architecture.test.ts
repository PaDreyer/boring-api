import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { it } from "node:test";
import ts from "typescript";
import { BoringApi } from "@boringapi/core";
import { generateTypes } from "@boringapi/typegen";
import { architectureFiles, checkArchitecture, formatArchitectureDiagnostics } from "../src";

const repository = join(__dirname, "..");

function project(files: Record<string, string>, run: (root: string) => void): void {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "boring-architecture-")));
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
            "@boringapi/core": [require.resolve("@boringapi/core").replace(/\.js$/, ".d.ts")],
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
            'throw new Error("must not execute");',
            'import { read } from "./service";',
            'import type { Store } from "./ports/storage";',
            'export function createOrders(store: Store) { return { get() { check(); return read(store); } }; }',
        ].join("\n"),
        "modules/orders/service.ts": 'import type { Store } from "./ports/storage"; export function read(store: Store) { return store.read(); }',
        "modules/orders/ports/storage.ts": 'export interface Store { read(): string; }',
        "infra/store.ts": 'import type { Store } from "../modules/orders/ports/storage"; export const store: Store = { read: () => "ok" };',
        "web/client/page.tsx": 'import { order } from "../../modules/orders/schemas"; export const example = order.parse("ok");',
    }, root => {
        const result = inspect(root);
        assert.deepEqual(result.diagnostics.map(error => error.message), []);
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

it("rejects foreign internals through aliases, re-exports and type imports and rejects a facade forwarding private implementations", () => {
    project({
        "modules/orders/facade.ts": 'export { secret as publicOperation } from "./internal/store";',
        "modules/orders/internal/store.ts": 'export const secret = 1; export type Record = { id: string };',
        "modules/billing/facade.ts": 'export { secret } from "@app/modules/orders/internal/store";',
        "modules/billing/internal/types.ts": 'import type { Record } from "../../orders/internal/store"; export type Copy = Record;',
        "api/get.ts": 'import { secret } from "../modules/billing/facade"; export const handler = () => secret;',
    }, root => {
        const { diagnostics } = inspect(root);
        assert.equal(diagnostics.filter(diagnostic => diagnostic.code === "BORING102").length, 3);
        assert.ok(diagnostics.some(diagnostic => diagnostic.file.fileName === join(root, "modules/orders/facade.ts")));
    });
});

it("keeps services private to their owning module across every application layer", () => {
    project({
        "api/+setup.ts": 'import { run } from "../modules/orders/service"; export const setup = () => ({ run });',
        "api/get.ts": 'import { run } from "../modules/orders/service"; export const handler = run;',
        "modules/orders/facade.ts": 'import { run } from "./service"; export const createOrders = () => ({ run });',
        "modules/orders/service.ts": 'export type Input = string; export const run = (input: Input) => input;',
        "modules/billing/facade.ts": 'export { run } from "@app/modules/orders/service";',
        "infra/store.ts": 'import type { Input } from "../modules/orders/service"; export type Stored = Input;',
        "web/server/pages.ts": 'import { run } from "../../modules/orders/service"; export const page = run;',
        "web/client/page.ts": 'import { run } from "../../modules/orders/service"; export const page = run;',
    }, root => {
        const { diagnostics } = inspect(root);
        assert.equal(diagnostics.filter(diagnostic => diagnostic.code === "BORING102" || diagnostic.code === "BORING105").length, 6);
        assert.ok(diagnostics.some(diagnostic => diagnostic.code === "BORING112"));
        assert.ok(diagnostics.some(diagnostic => diagnostic.file.fileName === join(root, "modules/orders/facade.ts")));
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
        assert.equal(diagnostics.filter(diagnostic => diagnostic.code === "BORING101").length, 2);
        assert.ok(diagnostics.some(diagnostic => diagnostic.code === "BORING110"));
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
        const cycle = diagnostics.find(diagnostic => diagnostic.code === "BORING103");
        assert.ok(cycle);
        assert.match(cycle.message, /billing -> orders -> billing/);
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

it("rejects tooling value imports in browser code and schemas through public exports, aliases and re-exports", () => {
    project({
        "web/client/generate.ts": 'export { generateTypes } from "@boringapi/typegen";',
        "web/client/register.ts": 'import { registerTypeScript } from "@boringapi/compiler/register"; export const register = registerTypeScript;',
        "web/client/alias.ts": 'export * from "@tools";',
        "web/client/require.ts": 'const tools = require("@boringapi/typegen"); export const generate = tools.generateTypes;',
        "web/client/barrel.ts": 'export { generateTypes } from "./generate";',
        "web/client/types.ts": 'import type { TypegenResult } from "@boringapi/typegen"; export type Result = TypegenResult;',
        "modules/shared/schemas.ts": 'export { registerTypeScript } from "@boringapi/compiler/register";',
    }, root => {
        mkdirSync(join(root, "node_modules/@boringapi"), { recursive: true });
        for (const name of ["typegen", "compiler"]) {
            symlinkSync(dirname(require.resolve(`@boringapi/${name}/package.json`)), join(root, `node_modules/@boringapi/${name}`), "dir");
        }
        symlinkSync(dirname(require.resolve("@boringapi/core/package.json")), join(root, "node_modules/@boringapi/core"), "dir");
        symlinkSync(join(repository, "node_modules/@types"), join(root, "node_modules/@types"), "dir");
        const { program, diagnostics } = inspect(root, { paths: {
            "@tools": [require.resolve("@boringapi/typegen").replace(/\.js$/, ".d.ts")],
        } });
        assert.equal(ts.getPreEmitDiagnostics(program).length, 0);
        const imports = diagnostics.filter(diagnostic => diagnostic.code === "BORING105");
        assert.equal(imports.length, 5);
        assert.deepEqual(imports.map(diagnostic => basename(diagnostic.file.fileName)).sort(),
            ["alias.ts", "generate.ts", "register.ts", "require.ts", "schemas.ts"]);
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
        assert.equal(diagnostics.filter(diagnostic => diagnostic.code === "BORING109").length, 2);
        assert.ok(diagnostics.some(diagnostic => diagnostic.code === "BORING110"));
        assert.equal(diagnostics.filter(diagnostic => diagnostic.code === "BORING105").length, 1);

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
        assert.equal(diagnostics.filter(diagnostic => diagnostic.code === "BORING106").length, 7);
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
        assert.ok(diagnostics.some(diagnostic => diagnostic.code === "BORING102"));
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
        assert.equal(diagnostics.filter(diagnostic => diagnostic.code === "BORING107").length, 1);
        assert.ok(diagnostics.some(diagnostic => diagnostic.code === "BORING110"));
    });
});


it("startup and check reject prototype folder names using the ordinary URL convention", async () => {
    for (const name of ["_base", "_setup"]) {
        const root = realpathSync(mkdtempSync(join(tmpdir(), "boring-invalid-folder-")));
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

it("enforces roles across split files, unused helpers, ports and indirect infrastructure", () => {
    project({
        ...sdk,
        "modules/orders/service.ts": 'import { peer } from "./services/peer"; export const run = () => peer();',
        "modules/orders/services/peer.ts": 'export const peer = () => "ok";',
        "modules/orders/schemas/helper.ts": 'export function execute(callback: () => string) { return callback(); }',
        "modules/orders/helpers.ts": 'import { peer } from "./services/peer"; export const helper = () => peer();',
        "modules/orders/ports/bad.ts": 'export const adapter = { read() { return "bad"; } };',
        "modules/orders/facade.ts": 'export { run } from "./service";',
        "modules/orders/facade/sdk.ts": 'import { query } from "database-sdk"; export const get = () => query();',
        "modules/orders/facade/adapter.ts": 'import { db } from "../../../infra/db"; export const get = () => db.read();',
        "modules/orders/schemas/leak.ts": 'export { peer } from "../services/peer";',
        "modules/foreign/service.ts": 'import type { peer } from "../orders/services/peer"; export type Leaked = typeof peer;',
        "infra/db.ts": 'export const db = { read() { return "bad"; } };',
    }, root => {
        const { diagnostics } = inspect(root);
        for (const [file, code] of [
            ["modules/orders/service.ts", "BORING102"], ["modules/orders/helpers.ts", "BORING107"],
            ["modules/orders/ports/bad.ts", "BORING111"], ["modules/orders/schemas/helper.ts", "BORING112"], ["modules/orders/facade.ts", "BORING112"],
            ["modules/orders/facade/sdk.ts", "BORING110"], ["modules/orders/facade/adapter.ts", "BORING110"],
            ["modules/orders/schemas/leak.ts", "BORING105"], ["modules/foreign/service.ts", "BORING102"],
        ]) assert.ok(diagnostics.some(error => error.file.fileName === join(root, file) && error.code === code), `${file}: ${code}`);
    });
});

it("rejects service aliases, returned capabilities, assertion erasure and setup exposure", () => {
    project({
        "modules/orders/service.ts": 'export const run = () => "order";',
        "modules/orders/ports/storage.ts": 'export interface Store { read(): string; }',
        "modules/orders/facade.ts": [
            'import { run } from "./service";',
            'import type { Store } from "./ports/storage";',
            'export const alias = run;',
            'const eager = run();',
            'export const eagerFactory = () => { const result = run(); return { get() { return result; } }; };',
            'export const raw = () => ({ run });',
            'export const nested = () => ({ get() { return { run }; } });',
            'export const cast = (store: Store) => ({ get(): {} { return store as {}; } });',
            'export const erased = (store: Store) => { const hidden: {} = store; return { get() { return hidden; } }; };',
            'function hide(store: Store): {} { return store; }',
            'export type HiddenService = typeof run;',
            'export const allowed = () => ({ get() { return run(); } });',
        ].join("\n"),
        "infra/db.ts": 'export const db = { read() { return "order"; } };',
        "api/+setup.ts": [
            'import { db } from "../infra/db";',
            'import { allowed } from "../modules/orders/facade";',
            'export function setup() {',
            ' const orders = allowed();',
            ' orders.get = db.read;',
            ' return { orders, raw: db, wrapper: { get() { return db.read(); } }, cast: db as {}, ...db };',
            '}',
        ].join("\n"),
    }, root => {
        const { diagnostics } = inspect(root);
        for (const code of ["BORING112", "BORING113", "BORING114"]) assert.ok(diagnostics.some(error => error.code === code));
        const setup = diagnostics.filter(error => error.file.fileName === join(root, "api/+setup.ts"));
        assert.ok(setup.length >= 5, setup.map(error => error.message).join("\n"));
        assert.ok(!diagnostics.some(error => error.file.fileName === join(root, "modules/orders/facade.ts") && error.start >=
            error.file.text.indexOf("export const allowed")));
    });
});

it("accepts split facade orchestration with transaction and effect ports", () => {
    project({
        "modules/orders/schemas.ts": 'export type { Order } from "./schemas/order";',
        "modules/orders/schemas/order.ts": 'export interface Order { id: string; }',
        "modules/orders/ports/storage.ts": 'import type { Order } from "../schemas"; export interface Repository { read(): Promise<Order>; }',
        "modules/orders/ports/transaction.ts": 'import type { Repository } from "../ports/storage"; export interface Database { transaction<T>(run: (repository: Repository) => Promise<T>): Promise<T>; }',
        "modules/orders/services/read.ts": 'import type { Repository } from "../ports/storage"; export const read = (repository: Repository) => repository.read();',
        "modules/orders/facade/operations.ts": 'import type { Database } from "../ports/transaction"; import { read } from "../services/read"; export const createOrders = (database: Database) => ({ get() { return database.transaction(repository => read(repository)); } });',
        "modules/orders/facade.ts": 'export { createOrders } from "./facade/operations";',
        "infra/database.ts": 'import type { Database } from "../modules/orders/ports/transaction"; export const database: Database = { transaction: run => run({ read: async () => ({ id: "1" }) }) };',
        "api/+setup.ts": 'import { database } from "../infra/database"; import { createOrders } from "../modules/orders/facade"; export const setup = () => ({ orders: createOrders(database) });',
    }, root => {
        const { program, diagnostics } = inspect(root);
        assert.equal(ts.getPreEmitDiagnostics(program).length, 0);
        assert.deepEqual(diagnostics.map(error => error.message), []);
    });
});

it("checks imperative setup writes, mutable aliases and unsupported boundary forms", () => {
    project({
        "infra/store.ts": 'export const store = { read() { return "raw"; } };',
        "modules/orders/facade.ts": 'export function createOrders() { return { get() { return "ok"; } }; }',
        "api/+setup.ts": [
            'import type { SetupContext } from "@boringapi/core";',
            'import { store } from "../infra/store";',
            'import { createOrders } from "../modules/orders/facade";',
            'export function setup(ctx: SetupContext) {',
            ' ctx.set("raw", store);',
            ' ctx.assign({ raw: store });',
            ' const setter = ctx.set.bind(ctx);',
            ' let changed = createOrders();',
            ' return { changed, factory: createOrders };',
            '}',
        ].join("\n"),
        "modules/common/facade.js": 'module.exports = { get: () => "opaque" };',
        "modules/lazy/service.ts": 'export const run = () => "ok";',
        "modules/lazy/facade.ts": 'const service = require("./service"); export const get = (): string => service.run();',
        "modules/inline/facade.ts": 'export interface Raw { read(): string; } export function create(raw: Raw) { return { read() { return raw.read(); } }; }',
    }, root => {
        const { diagnostics } = inspect(root);
        const setup = diagnostics.filter(error => error.code === "BORING113" && error.file.fileName === join(root, "api/+setup.ts"));
        assert.equal(setup.length, 6, setup.map(error => error.message).join("\n"));
        assert.ok(setup.some(error => error.message.includes("Do not erase or structurally replace SetupContext")));
        assert.ok(diagnostics.some(error => error.code === "BORING112" && error.file.fileName === join(root, "modules/common/facade.js")));
        assert.ok(diagnostics.some(error => error.code === "BORING114" && error.file.fileName === join(root, "modules/lazy/facade.ts")));
        assert.ok(diagnostics.some(error => error.code === "BORING112" && error.file.fileName === join(root, "modules/inline/facade.ts")));
    });
});


it("prevents entry points from replacing shared facade operations, including untyped JS aliases", () => {
    project({
        "api/get.js": 'exports.handler = ctx => { const application = ctx.services; application.orders.get = () => "replacement"; return "ok"; };',
    }, root => {
        assert.ok(inspect(root).diagnostics.some(error => error.code === "BORING113"));
    });
});

it("checks shared recursive data graphs once without mistaking them for capability objects", () => {
    const types = ['export interface Data0 { value: string; next?: Data40; }'];
    for (let index = 1; index <= 40; index++) types.push(`export interface Data${index} { left: Data${index - 1}; right: Data${index - 1}; }`);
    const dependencies = ['import type { NewId } from "./ports/id"; interface Deps0 { newId: NewId; }'];
    for (let index = 1; index <= 40; index++) dependencies.push(`interface Deps${index} { left: Deps${index - 1}; right: Deps${index - 1}; }`);
    project({
        "modules/tree/ports/id.ts": 'export type NewId = () => string;',
        "modules/tree/schemas.ts": types.join("\n"),
        "modules/tree/facade.ts": dependencies.join("\n") + '\nimport type { Data40 } from "./schemas"; export const echo = (value: Data40): Data40 => value; export function create(_dependencies: Deps40) { return { get() { return "ok"; } }; }',
    }, root => {
        assert.deepEqual(inspect(root).diagnostics.map(error => error.message), []);
    });
});

it("rejects services hiding ports behind data annotations before returning them through a facade", () => {
    project({
        "modules/orders/ports/storage.ts": 'export interface Store { read(): string; }',
        "modules/orders/service.ts": 'import type { Store } from "./ports/storage"; export function leak(store: Store): {} { return store; }',
        "modules/orders/services/alias.ts": 'import type { Store } from "../ports/storage"; export function leak(store: Store): {} { const hidden: {} = store; return hidden; }',
        "modules/orders/services/arrow.ts": 'import type { Store } from "../ports/storage"; export const leak = (store: Store): {} => store;',
        "modules/orders/facade.ts": 'import type { Store } from "./ports/storage"; import { leak } from "./service"; export const create = (store: Store) => ({ get() { return leak(store); } });',
    }, root => {
        const { program, diagnostics } = inspect(root);
        assert.equal(ts.getPreEmitDiagnostics(program).length, 0);
        for (const file of ["service.ts", "services/alias.ts", "services/arrow.ts"]) {
            assert.ok(diagnostics.some(error => error.file.fileName === join(root, "modules/orders", file) && error.code === "BORING112"), file);
        }
    });
});

it("allows a service to invoke an injected callable port", () => {
    project({
        "modules/orders/ports/id.ts": 'export type NewId = () => string;',
        "modules/orders/service.ts": 'import type { NewId } from "./ports/id"; export const create = (newId: NewId) => ({ id: newId() });',
        "modules/orders/facade.ts": 'import type { NewId } from "./ports/id"; import { create } from "./service"; export const createOrders = (newId: NewId) => ({ create() { return create(newId); } });',
    }, root => {
        const { program, diagnostics } = inspect(root);
        assert.equal(ts.getPreEmitDiagnostics(program).length, 0);
        assert.deepEqual(diagnostics.map(error => error.message), []);
    });
});
