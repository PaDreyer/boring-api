import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import ts from "typescript";
import { analyzeProject, inspectProject } from "../src";

function project(files: Record<string, string>, run: (result: ReturnType<typeof analyzeProject>, root: string) => void) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "boring-boundary-regression-")));
    try {
        const sources = {
            "package.json": '{"name":"boundary-regression","private":true}',
            "tsconfig.json": JSON.stringify({ compilerOptions: {
                target: "ES2020", module: "commonjs", moduleResolution: "node", strict: true,
                esModuleInterop: true, skipLibCheck: true, baseUrl: ".",
                paths: { "@boringapi/core": [require.resolve("@boringapi/core").replace(/\.js$/, ".d.ts")],
                    zod: [join(__dirname, "../node_modules/zod")] },
            }, include: ["api", "modules", "infra"] }),
            "api/get.ts": 'export const handler = () => "ok";',
            ...files,
        };
        for (const [name, content] of Object.entries(sources)) {
            const file = join(root, name);
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, content);
        }
        const result = analyzeProject(root, "api");
        assert.deepEqual(result.diagnostics.map(error => ts.flattenDiagnosticMessageText(error.messageText, "\n")), []);
        run(result, root);
    } finally { rmSync(root, { recursive: true, force: true }); }
}

function rejected(result: ReturnType<typeof analyzeProject>, code: string, file: string) {
    assert.ok(result.architecture.some(error => error.code === code && error.file.fileName.endsWith(file)),
        `${file}: expected ${code}; ${result.architecture.map(error => error.message).join("\n")}`);
    assert.throws(() => inspectProject(result), /Cannot inspect/);
}

it("rejects destructured, renamed, nested, assigned and computed setup setters", () => {
    for (const body of [
        'const { assign } = ctx; assign.call(ctx, { raw: store });',
        'const { set: write } = ctx; write.call(ctx, "raw", store);',
        'const { nested: { assign } } = { nested: ctx }; assign.call(ctx, { raw: store });',
        'let write: SetupContext["assign"]; ({ assign: write } = ctx); write.call(ctx, { raw: store });',
        'const key = "assign"; const write = ctx[key]; write.call(ctx, { raw: store });',
        'const writable: { assign(values: unknown): void } = ctx; const { assign } = writable; assign.call(ctx, { raw: store });',
        'let writable: { assign(values: unknown): void }; writable = ctx; writable.assign({ raw: store });',
    ]) project({
        "infra/store.ts": 'export const store = { read() { return "raw"; } }; throw new Error("must not execute");',
        "api/+setup.ts": `import type { SetupContext } from "@boringapi/core"; import { store } from "../infra/store"; export function setup(ctx: SetupContext) { ${body} }`,
    }, result => rejected(result, "BORING113", "api/+setup.ts"));
    project({
        "api/+setup.ts": 'import type { SetupContext } from "@boringapi/core"; export function setup({ assign }: SetupContext) { void assign; }',
    }, result => rejected(result, "BORING113", "api/+setup.ts"));
});

it("rejects port erasure at ordinary, generic, nested and rest argument boundaries", () => {
    for (const [service, call] of [
        ['export function hide(value: {}): {} { return value; }', 'hide(store)'],
        ['export function hide<T extends {}>(value: T): {} { return value; }', 'hide(store)'],
        ['export function hide(value: { nested: {} }): {} { return value.nested; }', 'hide({ nested: store })'],
        ['export function hide(...values: {}[]): {} { return values[1]; }', 'hide({}, store)'],
        ['import type { Store } from "./ports/storage"; export function hide(input: { port: Store; hidden: {} }): {} { return input.hidden; }', 'hide({ port: store, hidden: store })'],
        ['import type { Store } from "./ports/storage"; export function hide(...input: [Store, {}]): {} { return input[1]; }', 'hide(store, store)'],
        ['export function hide(get: () => {}): {} { return get(); }', 'hide(() => store)'],
        ['import type { Store } from "./ports/storage"; export function hide(store: Store, callback: (value: Store) => {}): {} { return callback(store); }', 'hide(store, (value: {}) => value)'],
        ['import type { Store } from "./ports/storage"; export async function hide(input: Promise<{ port: Store; hidden: {} }>): Promise<{}> { return (await input).hidden; }', 'hide(Promise.resolve({ port: store, hidden: store }))'],
    ]) project({
        "modules/orders/ports/storage.ts": 'export interface Store { read(): string; }',
        "modules/orders/service.ts": service,
        "modules/orders/facade.ts": `import type { Store } from "./ports/storage"; import { hide } from "./service"; export function create(store: Store) { return { get() { return ${call}; } }; }`,
    }, result => rejected(result, "BORING112", "modules/orders/facade.ts"));
});

it("checks mixed capability and data fields in service return annotations", () => {
    for (const service of [
        'export function hide(store: Store): { port: Store; hidden: {} } { return { port: store, hidden: store }; }',
        'export async function hide(store: Store): Promise<{ port: Store; hidden: {} }> { return { port: store, hidden: store }; }',
    ]) project({
        "modules/orders/ports/storage.ts": 'export interface Store { read(): string; }',
        "modules/orders/service.ts": `import type { Store } from "./ports/storage"; ${service}`,
        "modules/orders/facade.ts": 'import type { Store } from "./ports/storage"; import { hide } from "./service"; export function create(store: Store) { return { async get() { return (await hide(store)).hidden; } }; }',
    }, result => rejected(result, "BORING112", "modules/orders/service.ts"));
});

it("rejects capability erasure in schema declarations, assignments and helper calls", () => {
    for (const schema of [
        'const run = () => "helper"; export const hidden: {} = { run };',
        'const run = () => "helper"; export let hidden: {} = {}; hidden = { run };',
        'const run = () => "helper"; function hide(value: {}): {} { return value; } export const hidden = hide({ run });',
    ]) project({
        "modules/orders/schemas.ts": schema,
        "api/get.ts": 'import { hidden } from "../modules/orders/schemas"; export const handler = () => (hidden as { run(): string }).run();',
    }, result => rejected(result, "BORING112", "modules/orders/schemas.ts"));
});

it("rejects callable service containers regardless of property syntax or call location", () => {
    for (const service of [
        'export const service = { "run": () => "business" };',
        'export const service = { ["run"]() { return "business"; } };',
        'export const service = { nested: { "run": () => "business" } };',
        'export class service { static ["run"]() { return "business"; } }',
    ]) project({
        "modules/orders/service.ts": service,
        "modules/orders/facade.ts": `import { service } from "./service"; const eager = ${service.includes("nested") ? 'service.nested["run"]()' : 'service["run"]()'}; export function create() { return { get() { return eager; } }; }`,
    }, result => rejected(result, "BORING114", "modules/orders/service.ts"));
});

it("accepts inline type imports and exports across ports, adapters and setup", () => {
    project({
        "modules/orders/ports/store.ts": 'export interface Store { read(): string; }',
        "modules/orders/ports/storage.ts": 'import { type Store } from "./store"; export { type Store }; export { type Store as Repository } from "./store";',
        "modules/orders/schemas.ts": 'import z from "zod"; export const result = z.object({ id: z.string(), tags: z.array(z.string()).optional(), tuple: z.tuple([z.string(), z.number()]) });',
        "modules/orders/service.ts": 'import { type Repository } from "./ports/storage"; export class Missing extends Error { constructor() { super("missing"); } } export function read(store: Repository) { return store.read(); }',
        "modules/orders/facade.ts": 'import { type Store } from "./ports/storage"; import { read } from "./service"; export function create(store: Store) { return { get() { return read(store); } }; }',
        "infra/store.ts": 'import { type Store } from "../modules/orders/ports/storage"; export const store: Store = { read: () => "ok" };',
        "api/+setup.ts": 'import type { SetupContext } from "@boringapi/core"; import { type Store } from "../modules/orders/ports/storage"; import { create } from "../modules/orders/facade"; import { store } from "../infra/store"; export function setup(ctx: SetupContext) { const port: Store = store; ctx.assign({ orders: create(port) }); ctx.set("name", "ok"); return { orders: create(port) }; }',
    }, result => {
        assert.deepEqual(result.architecture.map(error => error.message), []);
        assert.equal(inspectProject(result).schemaVersion, 6);
    });
});

it("allows only data in error instances and static error properties", () => {
    for (const service of [
        'export class Disguised extends Error { static hidden: {} = () => "business"; }',
        'export class Disguised extends Error { constructor(readonly operation: () => string) { super("hidden"); } }',
    ]) project({
        "modules/orders/service.ts": service,
    }, result => rejected(result, "BORING114", "modules/orders/service.ts"));
});

it("keeps mixed, empty and side-effect imports as runtime dependencies", () => {
    project({
        "modules/orders/ports/store.ts": 'export interface Store { read(): string; }',
        "modules/orders/ports/empty.ts": 'import {} from "./store"; export {};',
        "modules/orders/ports/side-effect.ts": 'import "./store"; export {};',
        "modules/orders/ports/mixed.ts": 'import { type Data, value } from "../schemas"; export type Record = Data;',
        "modules/orders/schemas.ts": 'export interface Data { id: string; } export const value = "runtime";',
    }, result => {
        for (const file of ["empty", "side-effect", "mixed"]) rejected(result, "BORING111", `ports/${file}.ts`);
    });
});

it("allows only the exact Core execution context as the first operation argument", () => {
    project({
        "api/+config.ts": 'import z from "zod"; export const schema = z.object({ label: z.string() }); export function load(env: Record<string, string | undefined>) { return { label: env.LABEL }; }',
        "modules/orders/facade.ts": 'import type { ExecutionContext } from "@boringapi/core"; type Invocation = ExecutionContext; export function create() { return { get(ctx: Invocation, id: string) { ctx.throwIfAborted(); return { id, tenant: ctx.tenantId }; } }; }',
        "api/+setup.ts": 'import { create } from "../modules/orders/facade"; import type { SetupContext } from "./$types"; export function setup(ctx: SetupContext) { ctx.onClose("owned", async () => {}); return { label: ctx.config.label, orders: create() }; }',
        "executions/read.ts": 'import type { Application, ExecutionIdentity } from "@boringapi/core"; import type { Services } from "../api/$types"; export function run(app: Application<Services>, identity: ExecutionIdentity) { return app.execute({ identity }, ({ execution, services }) => services.orders.get(execution, "one")); }',
    }, result => {
        assert.deepEqual(result.architecture.map(error => error.message), []);
        const catalog = inspectProject(result);
        assert.ok(catalog.configuration?.schema);
        assert.deepEqual(catalog.lifecycle.executions, ["executions/read.ts"]);
        assert.ok(catalog.roles.some(source => source.role === "config"));
    });
    for (const parameters of [
        'value: { ctx: ExecutionContext }', 'id: string, ctx: ExecutionContext',
        'signal: AbortSignal', 'ctx: ExecutionContext & { hidden(): string }',
        'ctx: Pick<ExecutionContext, "signal">', 'ctx: ExecutionContext<any>',
        'ctx: Readonly<ExecutionContext>',
    ]) project({
        "modules/orders/facade.ts": `import type { ExecutionContext } from "@boringapi/core"; export function read(${parameters}) { return "ok"; }`,
    }, result => rejected(result, "BORING112", "modules/orders/facade.ts"));
});

it("rejects execution context factory capture, returns, erased values, fabricated casts and module storage", () => {
    for (const [body, code] of [
        ['export function create(ctx: ExecutionContext) { return { get() { return ctx.correlationId; } }; }', 'BORING112'],
        ['export function read(ctx: ExecutionContext) { return ctx; }', 'BORING112'],
        ['export function read(ctx: ExecutionContext): {} { return ctx as {}; }', 'BORING112'],
        ['export function read() { const fake = {} as ExecutionContext; fake.throwIfAborted(); return "ok"; }', 'BORING115'],
        ['export function read() { const fake: ExecutionContext = {} as any; fake.throwIfAborted(); return "ok"; }', 'BORING115'],
        ['function invoke(ctx: ExecutionContext) { ctx.throwIfAborted(); return "ok"; } export function read() { return invoke({} as any); }', 'BORING115'],
        ['let saved: ExecutionContext | undefined; export function read(ctx: ExecutionContext) { saved = ctx; return "ok"; }', 'BORING115'],
        ['const saved: ExecutionContext[] = []; export function read(ctx: ExecutionContext) { saved.push(ctx); return "ok"; }', 'BORING115'],
    ]) project({
        "modules/orders/facade.ts": `import type { ExecutionContext } from "@boringapi/core"; ${body}`,
    }, result => rejected(result, code, "modules/orders/facade.ts"));
});

it("checks configuration, non-HTTP entries and business error dependencies without executing source", () => {
    project({
        "infra/resource.ts": 'export const resource = { close() {} };',
        "api/+config.ts": 'import z from "zod"; import { resource } from "../infra/resource"; export const schema = z.object({}); export function load() { return { resource }; }',
        "modules/orders/service.ts": 'export function read() { return "private"; }',
        "executions/read.ts": 'import { read } from "../modules/orders/service"; export const result = read();',
        "modules/errors/facade.ts": 'import { HttpError as Failure } from "@boringapi/core"; export function fail(): never { throw new Failure(404, "missing"); }',
    }, result => {
        rejected(result, "BORING115", "api/+config.ts");
        rejected(result, "BORING102", "executions/read.ts");
        rejected(result, "BORING115", "modules/errors/facade.ts");
    });
});

it("rejects contexts retained in facade, split-facade, page and setup closures", () => {
    const retained = 'let previous: ExecutionContext | undefined; return { read(ctx: ExecutionContext) { const other = previous?.identity?.id; previous = ctx; return other; } };';
    const context = 'import type { ExecutionContext } from "@boringapi/core";';
    project({
        "modules/orders/facade.ts": `${context} export function create() { ${retained} }`,
        "modules/split/facade.ts": 'export { create } from "./facade/create";',
        "modules/split/facade/create.ts": `${context} export const create = () => { ${retained} };`,
        "web/server/pages.ts": `${context} export function createPages() { ${retained} }`,
        "api/+setup.ts": `${context}
import type { SetupContext } from "./$types";
import { create } from "../modules/orders/facade";
import { create as createSplit } from "../modules/split/facade";
import { createPages } from "../web/server/pages";
export function setup(ctx: SetupContext) {
    let pending: ExecutionContext | undefined;
    ctx.onClose("pending", () => { pending?.throwIfAborted(); });
    return { orders: create(), split: createSplit(), pages: createPages() };
}`,
    }, result => {
        for (const file of ["modules/orders/facade.ts", "modules/split/facade/create.ts", "web/server/pages.ts", "api/+setup.ts"]) {
            rejected(result, "BORING115", file);
        }
    });
});

it("rejects contexts retained in typed collections and accessor containers", () => {
    const stores = [
        'const saved = new Map<string, Invocation>();',
        'const saved = new Set<Invocation>();',
        'const saved = new WeakMap<object, Invocation>();',
        'const saved = new WeakSet<Invocation>();',
        'let saved: ReadonlyMap<string, Invocation>;',
        'let saved: Readonly<Map<string, Invocation>>;',
        'let saved: { nested: Promise<Invocation> };',
        'let saved: { current(): Invocation };',
        'interface Derived extends Invocation {} let saved: Derived;',
        'interface Derived extends Invocation {} const saved = new Map<string, Derived>();',
    ];
    project(Object.fromEntries(stores.map((store, index) => [`modules/storage${index}/facade.ts`,
        `import type { ExecutionContext as Invocation } from "@boringapi/core"; ${store}
export function read(ctx: Invocation) { return ctx.identity?.id; }`])), result => {
        stores.forEach((_store, index) => rejected(result, "BORING115", `modules/storage${index}/facade.ts`));
    });
});

it("preserves invocation-local context collections, data caches and generic context-taking ports", () => {
    project({
        "modules/orders/ports/execution.ts": 'export interface Runner<T> { run(ctx: T): string; }',
        "modules/orders/facade.ts": `import type { ExecutionContext } from "@boringapi/core";
import type { Runner } from "./ports/execution";
const cache = new Map<string, string>();
export function create(runner: Runner<ExecutionContext>) {
    let count = 0;
    return { read(ctx: ExecutionContext) {
        const current: ExecutionContext = ctx;
        const local = new Map<string, ExecutionContext>();
        local.set("current", current);
        count++;
        const value = runner.run(current);
        cache.set(value, value);
        return { count, value, identity: local.get("current")?.identity?.id };
    } };
}`,
    }, result => {
        assert.deepEqual(result.architecture.map(error => error.message), []);
        assert.equal(inspectProject(result).schemaVersion, 6);
    });
});


it("rejects the removed repository filename instead of retaining a second storage convention", () => {
    project({ "modules/orders/repository.ts": "export interface Store { read(): string; }" }, result => rejected(result, "BORING107", "modules/orders/repository.ts"));
});
