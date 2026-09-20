import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import ts from "typescript";
import { analyzeProject, inspectProject, formatArchitectureDiagnostics } from "../src";
const declaration = `import { input } from "$modules/orders/schemas";
import type { JobHandler } from "./$types";
export const payload = input;
export const version = 1;
export const policy = {maxAttempts:3,retryDelayMs:10,timeoutMs:1000} as const;
export const handler: JobHandler = async ctx => { await ctx.services.orders.create(ctx.execution, ctx.payload); };`;
function fixture(run: (root: string, write: (name: string, content: string) => void) => void) {
    const root = mkdtempSync(join(tmpdir(), "boring-job-check-"));
    const write = (name: string, content: string) => { const file = join(root, name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, content); };
    try {
        mkdirSync(join(root, "node_modules/@boringapi"), { recursive: true });
        symlinkSync(dirname(require.resolve("@boringapi/core/package.json")), join(root, "node_modules/@boringapi/core"), "dir");
        symlinkSync(join(__dirname, "../node_modules/zod"), join(root, "node_modules/zod"), "dir");
        symlinkSync(join(__dirname, "../node_modules/@types"), join(root, "node_modules/@types"), "dir");
        write("tsconfig.json", JSON.stringify({ extends: "./.boring/tsconfig.json", compilerOptions: { strict: true, skipLibCheck: true, target: "ES2020", module: "commonjs", esModuleInterop: true }, include: ["**/*.ts"] }));
        write("api/+setup.ts", 'import { createOrders } from "$modules/orders/facade"; export const setup = () => ({ orders: createOrders() });');
        write("modules/orders/schemas.ts", 'import { z } from "zod"; export const input = z.object({ value: z.string() });');
        write("modules/orders/facade.ts", 'import type { ExecutionContext } from "@boringapi/core"; export function createOrders() { return { create(execution: ExecutionContext, input: {value:string}) { execution.throwIfAborted(); return input; } }; }');
        write("jobs/orders/create/job.ts", declaration + '\nthrow new Error("Inspection must never execute jobs");');
        run(root, write);
    } finally { rmSync(root, { recursive: true, force: true }); }
}
function messages(root: string) { const p = analyzeProject(root, "api"); return { p, text: formatArchitectureDiagnostics(p.architecture, root) }; }

it("discovers typed job payloads, policies, facade reuse and role dependencies without executing modules", () => fixture(root => {
    const { p, text } = messages(root);
    assert.equal(p.diagnostics.length, 0, ts.formatDiagnostics(p.diagnostics, { getCanonicalFileName: x => x, getCurrentDirectory: () => root, getNewLine: () => "\n" }));
    assert.equal(text, "");
    const catalog = inspectProject(p); assert.equal(catalog.schemaVersion, 4);
    assert.equal(catalog.jobs[0].name, "orders/create"); assert.deepEqual(catalog.jobs[0].operations, ["ctx.services.orders.create"]);
    assert.equal(catalog.jobs[0].version?.kind, "literal"); assert.equal(catalog.jobs[0].payload?.inputType.includes("value: string"), true);
    assert.ok(catalog.roles.some(source => source.role === "job"));
}));

it("rejects unused jobs importing services/adapters/facades, aliases, re-exports and literal CommonJS bypasses", () => fixture((root, write) => {
    write("modules/orders/service.ts", 'export function raw() { return "bad"; }');
    write("infra/db.ts", 'export const raw = () => "db";');
    const cases = [
        'import { raw } from "$modules/orders/service";',
        'import type { raw } from "$modules/orders/service";',
        'export { raw } from "$infra/db";',
        'const raw = require("../../../infra/db");',
        'const raw = require("../../../modules/orders/service");',
        'import { createOrders } from "$modules/orders/facade";',
        'const load = require; load("../../../infra/db");',
    ];
    cases.forEach((source, index) => write(`jobs/bypass/case-${index}/job.ts`, declaration + "\n" + source));
    const { text } = messages(root);
    cases.forEach((_, index) => assert.match(text, new RegExp(`jobs/bypass/case-${index}/job.ts.*BORING10[1246]`)));
    write("api/get.ts", 'export { handler } from "../jobs/orders/create/job";');
    assert.match(messages(root).text, /BORING104/);
}));

it("preserves setup capability/data boundaries and catches retained contexts, unchecked schemas and invalid declarations", () => fixture((root, write) => {
    write("api/+setup.ts", 'import type { SetupContext } from "./$types"; import type { JobAdapter } from "@boringapi/core"; declare const queue: JobAdapter; export function setup(ctx: SetupContext) { const bindings = ctx.jobs(queue, {identity:{kind:"machine",id:"worker",permissions:[]}}); return { queue, bindings, raw: bindings.for("orders/create") }; }');
    write("jobs/invalid/job.ts", 'import { z } from "zod"; export const payload=z.any(); export const version=0; export const policy={maxAttempts:0,retryDelayMs:1,timeoutMs:1}; export const handler=() => {};');
    write("jobs/retention/job.ts", declaration + '\nimport type { ExecutionContext } from "@boringapi/core"; const retained = new Map<string, Readonly<ExecutionContext>[]>();');
    const { text } = messages(root);
    assert.match(text, /BORING113/); assert.match(text, /BORING116/); assert.match(text, /BORING115/);
}));

it("rejects alternate application admission through named, namespace, element, CommonJS and aliased Core access", () => fixture((root, write) => {
    const cases = [
        'import { BoringApi } from "@boringapi/core";',
        'import * as core from "@boringapi/core"; const Factory = core["BoringApi"];',
        'const core = require("@boringapi/core"); const {BoringApi:Factory}=core;',
        'const core = import("@boringapi/core");',
        'import { BoringApi as ApplicationError } from "@boringapi/core";',
    ];
    cases.forEach((source, index) => write(`jobs/admission/case-${index}/job.ts`, declaration + "\n" + source));
    const { text } = messages(root);
    cases.forEach((_, index) => assert.match(text, new RegExp(`jobs/admission/case-${index}/job.ts.*BORING116`)));
}));

it("checks handler payload and services against generated contracts even without a JobHandler annotation", () => fixture((root, write) => {
    write("jobs/orders/create/job.ts", declaration.replace('import type { JobHandler } from "./$types";', 'import type { JobContext } from "@boringapi/core";').replace('handler: JobHandler = async ctx', 'handler = async (ctx: JobContext<{other:string}, {}>)').replace('await ctx.services.orders.create(ctx.execution, ctx.payload);', 'void ctx.payload.other;'));
    assert.ok(analyzeProject(root, "api").diagnostics.some(diagnostic => diagnostic.code === 2344));
    write("jobs/orders/create/job.ts", declaration.replace('import type { JobHandler } from "./$types";', 'import type { JobContext } from "@boringapi/core";').replace('handler: JobHandler = async ctx', 'handler = async (ctx: JobContext<any, any>)'));
    assert.match(messages(root).text, /BORING116/);
}));

it("rejects reflective replacement of injected job facades, including element access and destructured aliases", () => fixture((root, write) => {
    const cases = [
        'Object.defineProperty(ctx.services.orders, "create", {value: () => ({value:"bypassed"})});',
        'Object["defineProperty"](ctx.services.orders, "create", {value: () => ({value:"bypassed"})});',
        'Object.defineProperties(ctx.services.orders, {create: {value: () => ({value:"bypassed"})}});',
        'Reflect.defineProperty(ctx.services.orders, "create", {value: () => ({value:"bypassed"})});',
        'const replace = Object.defineProperty; replace(ctx.services.orders, "create", {value: () => ({value:"bypassed"})});',
        'const {defineProperty: replace} = Object; replace(ctx.services.orders, "create", {value: () => ({value:"bypassed"})});',
        'const {defineProperty: replace} = Reflect; replace(ctx.services.orders, "create", {value: () => ({value:"bypassed"})});',
        'const properties = Object; properties.defineProperty(ctx.services.orders, "create", {value: () => ({value:"bypassed"})});',
        'const properties = Reflect; const {defineProperty: replace} = properties; replace(ctx.services.orders, "create", {value: () => ({value:"bypassed"})});',
        'globalThis.Object.defineProperty(ctx.services.orders, "create", {value: () => ({value:"bypassed"})});',
        'Object.setPrototypeOf(ctx.services.orders, {create: () => ({value:"bypassed"})});',
    ];
    cases.forEach((source, index) => write(`jobs/mutation/case-${index}/job.ts`, declaration.replace(
        'await ctx.services.orders.create(ctx.execution, ctx.payload);', source)));
    const { p, text } = messages(root);
    assert.equal(p.diagnostics.length, 0, ts.formatDiagnostics(p.diagnostics, {
        getCanonicalFileName: x => x, getCurrentDirectory: () => root, getNewLine: () => "\n",
    }));
    cases.forEach((_, index) => assert.match(text, new RegExp(`jobs/mutation/case-${index}/job.ts.*BORING113`)));
}));
