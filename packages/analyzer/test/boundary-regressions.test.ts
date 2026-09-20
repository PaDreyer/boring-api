import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import ts from "typescript";
import { analyzeProject, inspectProject } from "../src";

function project(files: Record<string, string>, run: (result: ReturnType<typeof analyzeProject>, root: string) => void) {
    const root = mkdtempSync(join(tmpdir(), "boring-boundary-regression-"));
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
        ['import type { Store } from "./repository"; export function hide(input: { port: Store; hidden: {} }): {} { return input.hidden; }', 'hide({ port: store, hidden: store })'],
        ['import type { Store } from "./repository"; export function hide(...input: [Store, {}]): {} { return input[1]; }', 'hide(store, store)'],
        ['export function hide(get: () => {}): {} { return get(); }', 'hide(() => store)'],
        ['import type { Store } from "./repository"; export function hide(store: Store, callback: (value: Store) => {}): {} { return callback(store); }', 'hide(store, (value: {}) => value)'],
        ['import type { Store } from "./repository"; export async function hide(input: Promise<{ port: Store; hidden: {} }>): Promise<{}> { return (await input).hidden; }', 'hide(Promise.resolve({ port: store, hidden: store }))'],
    ]) project({
        "modules/orders/repository.ts": 'export interface Store { read(): string; }',
        "modules/orders/service.ts": service,
        "modules/orders/facade.ts": `import type { Store } from "./repository"; import { hide } from "./service"; export function create(store: Store) { return { get() { return ${call}; } }; }`,
    }, result => rejected(result, "BORING112", "modules/orders/facade.ts"));
});

it("checks mixed capability and data fields in service return annotations", () => {
    for (const service of [
        'export function hide(store: Store): { port: Store; hidden: {} } { return { port: store, hidden: store }; }',
        'export async function hide(store: Store): Promise<{ port: Store; hidden: {} }> { return { port: store, hidden: store }; }',
    ]) project({
        "modules/orders/repository.ts": 'export interface Store { read(): string; }',
        "modules/orders/service.ts": `import type { Store } from "./repository"; ${service}`,
        "modules/orders/facade.ts": 'import type { Store } from "./repository"; import { hide } from "./service"; export function create(store: Store) { return { async get() { return (await hide(store)).hidden; } }; }',
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
        "modules/orders/repository.ts": 'import { type Store } from "./ports/store"; export { type Store }; export { type Store as Repository } from "./ports/store";',
        "modules/orders/schemas.ts": 'import z from "zod"; export const result = z.object({ id: z.string(), tags: z.array(z.string()).optional(), tuple: z.tuple([z.string(), z.number()]) });',
        "modules/orders/service.ts": 'import { type Repository } from "./repository"; export class Missing extends Error { constructor() { super("missing"); } } export function read(store: Repository) { return store.read(); }',
        "modules/orders/facade.ts": 'import { type Store } from "./repository"; import { read } from "./service"; export function create(store: Store) { return { get() { return read(store); } }; }',
        "infra/store.ts": 'import { type Store } from "../modules/orders/repository"; export const store: Store = { read: () => "ok" };',
        "api/+setup.ts": 'import type { SetupContext } from "@boringapi/core"; import { type Store } from "../modules/orders/repository"; import { create } from "../modules/orders/facade"; import { store } from "../infra/store"; export function setup(ctx: SetupContext) { const port: Store = store; ctx.assign({ orders: create(port) }); ctx.set("name", "ok"); return { orders: create(port) }; }',
    }, result => {
        assert.deepEqual(result.architecture.map(error => error.message), []);
        assert.equal(inspectProject(result).schemaVersion, 2);
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
