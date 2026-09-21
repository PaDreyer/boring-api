import { formatHost } from "@boringapi/compiler";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import ts from "typescript";
import { generateTypes } from "@boringapi/typegen";
import { analyzeProject } from "@boringapi/analyzer";
import { readConfiguration } from "@boringapi/compiler";
import { buildProject } from "../src";
import { inspectProject } from "@boringapi/analyzer";
import { registerTypeScript } from "@boringapi/compiler/register";

const { after } = require("node:test");
const repository = join(__dirname, "..");
const suite = mkdtempSync(join(tmpdir(), "boring-aliases-"));
const library = dirname(require.resolve("@boringapi/core/package.json"));
function write(root: string, file: string, content: string) {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
}
after(() => rmSync(suite, { recursive: true, force: true }));

function fixture() {
    const root = mkdtempSync(join(suite, "consumer-"));
    write(root, "package.json", '{"name":"consumer","private":true}');
    write(root, "tsconfig.json", JSON.stringify({
        extends: "./.boring/tsconfig.json",
        compilerOptions: { target: "ES2020", module: "commonjs", moduleResolution: "node", strict: true,
            esModuleInterop: true, skipLibCheck: true, rootDir: "app", outDir: "output", declaration: true, sourceMap: true, allowJs: true },
        include: ["app/**/*"],
    }));
    mkdirSync(join(root, "node_modules/@boringapi"), { recursive: true });
    symlinkSync(library, join(root, "node_modules/@boringapi/core"), "dir");
    symlinkSync(join(repository, "node_modules/zod"), join(root, "node_modules/zod"), "dir");
    symlinkSync(join(repository, "node_modules/@types"), join(root, "node_modules/@types"), "dir");
    write(root, "app/modules/orders/schemas.ts", [
        'import { z } from "zod";',
        'export const order = z.object({ id: z.string(), label: z.string() });',
        'export const orderParams = z.object({ id: z.string() });',
        'export const label = "aliased";',
        'export type Order = z.infer<typeof order>;',
    ].join("\n"));
    write(root, "app/modules/orders/facade/read.ts", [
        'import type { Order } from "$modules/orders/schemas";',
        'export const read = (id: string): Order => ({ id, label: "aliased" });',
    ].join("\n"));
    write(root, "app/modules/orders/schemas/model.d.ts", 'export interface Metadata { label: string; }');
    write(root, "app/modules/orders/facade/equals.ts", 'import schemas = require("$modules/orders/schemas"); export const equals = () => schemas.label;');
    write(root, "app/modules/orders/facade.ts", [
        'import { read } from "$modules/orders/facade/read";',
        'export { read } from "$modules/orders/facade/read";',
        'export type { Order } from "$modules/orders/schemas";',
        'export type OrderImport = import("$modules/orders/schemas").Order;',
        'export type { Metadata } from "./schemas/model";',
        'export { equals } from "./facade/equals";',
        'export const createOrders = () => ({ read });',
    ].join("\n"));
    write(root, "app/infra/loading.ts", [
        'import schemas = require("$modules/orders/schemas"); export const equals = () => schemas.label;',
        'export const lazy = async () => (await import("$modules/orders/schemas")).label;',
        'export const required = () => require("$modules/orders/schemas").label;',
        'export const moduleRequired = () => module.require("$modules/orders/schemas").label;',
        'export const bracketRequired = () => module["require"]("$modules/orders/schemas").label;',
        'export const shadowed = (require: (text: string) => string) => require("$modules/not/a/module");',
        'export const localScopes = () => { for (const require of []) {} try {} catch (require) {} return require("$modules/orders/schemas").label; };',
        'export const methods = { require() { return require("$modules/orders/schemas").label; } };',
    ].join("\n"));
    write(root, "app/http/+setup.ts", 'import { createOrders } from "$modules/orders/facade"; export const setup = () => ({ orders: createOrders() });');
    write(root, "app/http/orders/[id]/get.ts", [
        'import { order, orderParams } from "$modules/orders/schemas";',
        'import type { GetHandler } from "./$types";',
        'export const params = orderParams;',
        'export const output = order;',
        'export const handler: GetHandler = ctx => ctx.services.orders.read(ctx.params.id);',
    ].join("\n"));
    return root;
}

function checked(root: string) {
    const project = analyzeProject(root, "app/http");
    assert.equal(project.diagnostics.length, 0, ts.formatDiagnostics(project.diagnostics, formatHost(root)));
    assert.deepEqual(project.architecture.map(error => error.message), []);
    return project;
}

it("gates inspection and builds on the same setup exposure diagnostics", () => {
    const root = fixture();
    write(root, "app/infra/store.ts", 'export const store = { read() { return "raw"; } };');
    for (const setup of [
        'export const setup = () => ({ store });',
        'export function setup(ctx: SetupContext) { const { assign } = ctx; assign.call(ctx, { raw: store }); }',
    ]) {
        write(root, "app/http/+setup.ts", `import type { SetupContext } from "@boringapi/core"; import { store } from "$infra/store"; ${setup}`);
        const project = analyzeProject(root, "app/http");
        assert.ok(project.architecture.some(error => error.code === "BORING113"));
        assert.throws(() => inspectProject(project), /check errors/);
        assert.throws(() => buildProject(project), /check errors/);
        assert.equal(existsSync(join(root, "output")), false);
    }
});

it("blocks audited command mutation and retention patterns before emitting a build", () => {
    const root = fixture();
    const cases: [string, string][] = [
        ['function replace(orders:{read:(id:string)=>{id:string,label:string}}){[orders.read]=[id=>({id,label:"changed"})];} replace(ctx.services.orders);', "BORING113"],
        ['[saved]=[()=>ctx.execution.signal.aborted];', "BORING115"],
        ['({callback:saved}={callback:()=>ctx.execution.signal.aborted});', "BORING115"],
        ['saved=read.bind(null,ctx);', "BORING115"],
        ['const {signal}=ctx.execution; saved=()=>signal.aborted;', "BORING115"],
        ['function capture(...callbacks:Array<()=>boolean>){saved=callbacks[0];} capture(()=>ctx.execution.signal.aborted);', "BORING115"],
        ['function capture(callback=()=>ctx.execution.signal.aborted){saved=callback;} capture();', "BORING115"],
        ['const callbacks=[()=>ctx.execution.signal.aborted]; saved=callbacks.pop()!;', "BORING115"],
        ['const callbacks=[read.bind(null,ctx)]; saved=callbacks.shift()!;', "BORING115"],
        ['const callbacks=[()=>ctx.execution.signal.aborted]; saved=callbacks.slice()[0];', "BORING115"],
        ['function capture(callback:()=>boolean):void;function capture(callback:()=>boolean){saved=callback;}capture(()=>ctx.execution.signal.aborted);', "BORING115"],
        ['shared.reverse().push(()=>ctx.execution.signal.aborted);', "BORING115"],
        ['const callbacks=shared.sort();callbacks.push(()=>ctx.execution.signal.aborted);', "BORING115"],
        ['const callbacks:Array<()=>boolean>=[];const alias=callbacks.reverse();alias.push(()=>ctx.execution.signal.aborted);saved=callbacks[0];', "BORING115"],
        ['const callbacks=[()=>false,()=>ctx.execution.signal.aborted];callbacks.reverse();saved=callbacks[0];', "BORING115"],
        ['const callbacks=[()=>false,()=>ctx.execution.signal.aborted];callbacks.sort(()=>-1);saved=callbacks[0];', "BORING115"],
        ['const callbacks=[()=>false,()=>ctx.execution.signal.aborted];callbacks.copyWithin(0,1);saved=callbacks[0];', "BORING115"],
        ['const callbacks=[()=>false,()=>ctx.execution.signal.aborted];callbacks.shift();saved=callbacks[0];', "BORING115"],
        ['let capture:(callback:()=>boolean)=>void=actual=>{saved=actual;};capture(()=>ctx.execution.signal.aborted);', "BORING115"],
        ['let capture:(callback:()=>boolean)=>void=()=>{};capture=actual=>{saved=actual;};capture(()=>ctx.execution.signal.aborted);', "BORING115"],
        ['function capture(actual:()=>boolean){saved=actual;}capture.call(undefined,()=>ctx.execution.signal.aborted);', "BORING115"],
        ['function capture(actual:()=>boolean){saved=actual;}capture.apply(undefined,[()=>ctx.execution.signal.aborted]);', "BORING115"],
        ['const callbacks:Array<()=>boolean>=[];const nested=[callbacks];const copy=nested.slice();copy[0].push(()=>ctx.execution.signal.aborted);saved=callbacks[0];', "BORING115"],
        ['const captures:Array<(cb:()=>boolean)=>void>=[];captures.push(cb=>{saved=cb;});captures[0](()=>ctx.execution.signal.aborted);', "BORING115"],
        ['const captures:Array<(cb:()=>boolean)=>void>=[cb=>{saved=cb;}];captures.slice()[0](()=>ctx.execution.signal.aborted);', "BORING115"],
        ['const captures:Array<(cb:()=>boolean)=>void>=[cb=>{},cb=>{saved=cb;}];captures.reverse();captures[0](()=>ctx.execution.signal.aborted);', "BORING115"],
        ['const callbacks=[0].map(()=>()=>ctx.execution.signal.aborted);saved=callbacks[0];', "BORING115"],
        ['const callbacks=Array.from([0],()=>()=>ctx.execution.signal.aborted);saved=callbacks[0];', "BORING115"],
        ['const callbacks=[0].flatMap(()=>[()=>ctx.execution.signal.aborted]);saved=callbacks[0];', "BORING115"],
        ['const captures=[0].map(()=>(cb:()=>boolean)=>{saved=cb;});captures[0](()=>ctx.execution.signal.aborted);', "BORING115"],
        ['const callbacks=[0].map.call([0],()=>()=>ctx.execution.signal.aborted);saved=callbacks[0] as ()=>boolean;', "BORING115"],
        ['const callbacks=[0].map.apply([0],[()=>()=>ctx.execution.signal.aborted]);saved=callbacks[0] as ()=>boolean;', "BORING115"],
        ['const args:[(value:number)=>()=>boolean]=[()=>()=>ctx.execution.signal.aborted];const callbacks=[0].map.apply([0],args);saved=callbacks[0] as ()=>boolean;', "BORING115"],
        ['function makeArgs():[(value:number)=>()=>boolean]{return [()=>()=>ctx.execution.signal.aborted];}const callbacks=[0].map.apply([0],makeArgs());saved=callbacks[0] as ()=>boolean;', "BORING115"],
        ['const aborted=ctx.execution.signal.aborted;function makeArgs():[(value:number)=>()=>boolean]{return [()=>()=>aborted];}const callbacks=[0].map.apply([0],makeArgs());saved=callbacks[0] as ()=>boolean;', "BORING115"],
        ['const args:[(value:number)=>()=>boolean]=[()=>()=>false];const callbacks=[0].map(...args);saved=callbacks[0] as ()=>boolean;', "BORING115"],
        ['function makeArgs():[number[],(value:unknown)=>unknown]{return [[0],value=>value];}Array.from.apply(Array,makeArgs());', "BORING115"],
        ['const mapper=[0].map.bind([0]);const callbacks=mapper(()=>()=>ctx.execution.signal.aborted);saved=callbacks[0] as ()=>boolean;', "BORING115"],
        ['const callbacks=Array.from.call(Array,[0],()=>()=>ctx.execution.signal.aborted);saved=callbacks[0] as ()=>boolean;', "BORING115"],
        ['const carrier={callback:()=>ctx.execution.signal.aborted};const callbacks=[0].map(function(this:typeof carrier){return this.callback;},carrier);saved=callbacks[0];', "BORING115"],
        ['const carrier={callback:()=>ctx.execution.signal.aborted};const callbacks=Array.from([0],function(this:typeof carrier){return this.callback;},carrier);saved=callbacks[0];', "BORING115"],
        ['const capture=(cb:()=>boolean)=>{saved=cb;};const bound=capture.bind(undefined);[()=>ctx.execution.signal.aborted].forEach(bound);', "BORING115"],
        ['const capture=(_label:string,cb:()=>boolean)=>{saved=cb;};const bound=capture.bind(undefined,"retained");[()=>ctx.execution.signal.aborted].forEach(bound);', "BORING115"],
    ];
    for (const [operation, code] of cases) {
        write(root, "app/commands/audit/command.ts", `import {z} from "zod";
import type {CommandHandler,CommandContext} from "./$types";
export const input=z.object({}); export const output=z.boolean(); export const timeoutMs=1000;
const shared:Array<()=>boolean>=[]; let saved:()=>boolean=()=>false; function read(ctx:CommandContext){return ctx.execution.signal.aborted;}
export const handler:CommandHandler=ctx=>{${operation} return false;};`);
        const project = analyzeProject(root, "app/http");
        assert.equal(project.diagnostics.length, 0, ts.formatDiagnostics(project.diagnostics, formatHost(root)));
        assert.ok(project.architecture.some(error => error.code === code), operation);
        if (operation.includes("makeArgs") || operation.includes("map(...args)")) {
            const diagnostic = project.architecture.find(error => error.code === "BORING115" &&
                error.message.includes("dynamic apply or spread"));
            assert.ok(diagnostic, operation);
            assert.ok(diagnostic.start > 0 && diagnostic.length > 0);
        }
        assert.throws(() => inspectProject(project), /check errors/);
        assert.throws(() => buildProject(project), /check errors/);
        assert.equal(existsSync(join(root, "output")), false);
        assert.equal(existsSync(join(root, ".boring/build.json")), false);
    }
});

it("checks and inspects aliases, including unused modules, without executing source", () => {
    const root = fixture();
    write(root, "app/modules/unused/facade.ts", 'throw new Error("must not execute"); export const run = () => "ok";');
    const project = checked(root);
    const catalog = inspectProject(project);
    assert.equal(catalog.services[0].operations[0].access, "ctx.services.orders.read");
    assert.equal(catalog.modules.find(module => module.name === "unused")!.facade!.exports[0].name, "run");
    write(root, "app/modules/unused/facade.ts", 'import { read } from "$modules/orders/facade/read"; export { read };');
    assert.ok(analyzeProject(root, "app/http").architecture.some(error => error.code === "BORING102"));
    write(root, "app/modules/unused/facade.ts", 'export const bad = () => import("$modules/missing/schemas");');
    assert.ok(analyzeProject(root, "app/http").architecture.some(error => error.code === "BORING106"));
});

it("rejects directories colliding with generated build files before the first write and permits a corrected retry", () => {
    for (const reserved of ["boring-start.cjs", ".boring-build.json"]) {
        const root = fixture();
        write(root, `app/${reserved}/helper.ts`, "export const helper = true;");
        const config = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8"));
        config.include.push(`app/${reserved}/**/*.ts`);
        write(root, "tsconfig.json", JSON.stringify(config));
        assert.throws(() => buildProject(checked(root)), /is reserved/);
        assert.equal(existsSync(join(root, "output")), false);
        assert.equal(existsSync(join(root, ".boring/build.json")), false);
        rmSync(join(root, "app", reserved), { recursive: true });
        assert.deepEqual(buildProject(checked(root)).diagnostics.map(error => ts.flattenDiagnosticMessageText(error.messageText, "\n")), []);
        assert.ok(existsSync(join(root, "output/boring-start.cjs")));
        assert.ok(existsSync(join(root, "output/.boring-build.json")));
    }
});

it("rejects emitted JSON colliding with build metadata without overwriting application data", () => {
    const root = fixture();
    const config = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8"));
    config.compilerOptions.resolveJsonModule = true;
    write(root, "tsconfig.json", JSON.stringify(config));
    write(root, "app/.boring-build.json", '{"configured":true}');
    write(root, "app/server.ts", 'import config from "./.boring-build.json"; export const configured = config.configured;');
    assert.throws(() => buildProject(checked(root)), /\.boring-build.json is reserved/);
    assert.equal(existsSync(join(root, "output")), false);
    assert.equal(readFileSync(join(root, "app/.boring-build.json"), "utf8"), '{"configured":true}');
    renameSync(join(root, "app/.boring-build.json"), join(root, "app/configuration.json"));
    write(root, "app/server.ts", 'import config from "./configuration.json"; export const configured = config.configured;');
    assert.deepEqual(buildProject(checked(root)).diagnostics.map(error => ts.flattenDiagnosticMessageText(error.messageText, "\n")), []);
    assert.equal(require(join(root, "output/server.js")).configured, true);
});

it("preflights build reference collisions before writing output and permits a corrected retry", () => {
    for (const target of [".boring/build.json", ".boring/build.json/output", "existing-directory"]) {
        const root = fixture();
        const original = readFileSync(join(root, "tsconfig.json"), "utf8");
        const config = JSON.parse(original);
        const reference = join(root, ".boring/build.json");
        if (target === "existing-directory") mkdirSync(reference, { recursive: true });
        else config.compilerOptions.outDir = target;
        write(root, "tsconfig.json", JSON.stringify(config));
        assert.throws(() => buildProject(checked(root)), /build reference/);
        assert.equal(existsSync(join(root, "output")), false);
        if (target === "existing-directory") rmSync(reference, { recursive: true });
        else assert.equal(existsSync(reference), false);
        write(root, "tsconfig.json", original);
        assert.deepEqual(buildProject(checked(root)).diagnostics.map(error => ts.flattenDiagnosticMessageText(error.messageText, "\n")), []);
        assert.ok(existsSync(reference));
    }
});

it("reports editor mappings replaced by consumer paths and preserves unrelated aliases", () => {
    const root = fixture();
    const file = join(root, "tsconfig.json");
    const config = JSON.parse(readFileSync(file, "utf8"));
    config.compilerOptions.paths = { "@local/*": ["./app/modules/*"] };
    writeFileSync(file, JSON.stringify(config));
    let project = analyzeProject(root, "app/http");
    assert.ok(project.diagnostics.some(error => String(error.messageText).includes("BORING108")));
    config.compilerOptions.paths["$modules/*"] = ["./app/modules/*"];
    writeFileSync(file, JSON.stringify(config));
    project = checked(root);
    assert.deepEqual(project.program.getCompilerOptions().paths!["@local/*"], ["./app/modules/*"]);
    write(root, "app/http/orders/[id]/get.ts", 'import { read } from "$modules/../modules/orders/facade/read"; export const handler = read;');
    assert.ok(analyzeProject(root, "app/http").diagnostics.some(error => String(error.messageText).includes("BORING108")));
});

it("resolves $infra in separate source applications and portable runtime/declaration builds", async () => {
    const first = fixture();
    const second = fixture();
    for (const [root, label] of [[first, "first"], [second, "second"]]) {
        write(root, "app/infra/config.ts", `export const label = "${label}"; export interface Config { label: string; }`);
        write(root, "app/infra/adapter.ts", `import { label } from "$infra/config";
            import config = require("$infra/config");
            export { label } from "$infra/config";
            export type { Config } from "$infra/config";
            export type ImportedConfig = import("$infra/config").Config;
            export const direct = () => label;
            export const equals = () => config.label;
            export const lazy = async () => (await import("$infra/config")).label;
            export const required = () => require("$infra/config").label;
            export const moduleRequired = () => module.require("$infra/config").label;
            export const bracketRequired = () => module["require"]("$infra/config").label;
            export const shadowed = (require: (path: string) => string) => require("$infra/missing");`);
        checked(root);
        const configuration = readConfiguration(root);
        assert.deepEqual(configuration.options.paths!["$infra/*"], ["app/infra/*"]);
        const editor = ts.createProgram(configuration.fileNames, configuration.options);
        const diagnostics = ts.getPreEmitDiagnostics(editor);
        assert.equal(diagnostics.length, 0, ts.formatDiagnostics(diagnostics, formatHost(root)));
    }
    const stopFirst = registerTypeScript(join(first, "app/http"));
    const stopSecond = registerTypeScript(join(second, "app/http"));
    try {
        for (const [root, label] of [[first, "first"], [second, "second"]]) {
            const adapter = require(join(root, "app/infra/adapter.ts"));
            assert.equal(adapter.label, label);
            for (const name of ["direct", "equals", "lazy", "required", "moduleRequired", "bracketRequired"]) assert.equal(await adapter[name](), label);
            assert.equal(adapter.shadowed((path: string) => path), "$infra/missing");
        }
    } finally { stopSecond(); stopFirst(); }
    assert.deepEqual(buildProject(checked(first)).diagnostics.map(error => ts.flattenDiagnosticMessageText(error.messageText, "\n")), []);
    renameSync(join(first, "output"), join(first, "deployed"));
    const emitted = join(first, "deployed/infra/adapter");
    assert.doesNotMatch(readFileSync(`${emitted}.d.ts`, "utf8"), /\$infra/);
    const declarations = ts.createProgram([`${emitted}.d.ts`], {
        strict: true, noEmit: true, target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
    });
    const diagnostics = ts.getPreEmitDiagnostics(declarations);
    assert.equal(diagnostics.length, 0, ts.formatDiagnostics(diagnostics, formatHost(first)));
    assert.ok(!declarations.getSourceFiles().some(file => file.fileName.startsWith(join(first, "app"))));
    const run = spawnSync(process.execPath, ["-e", `const assert = require("node:assert/strict");
        const adapter = require("./deployed/infra/adapter.js");
        (async () => {
            assert.equal(adapter.label, "first");
            for (const name of ["direct", "equals", "lazy", "required", "moduleRequired", "bracketRequired"]) assert.equal(await adapter[name](), "first");
        })().catch(error => { console.error(error); process.exitCode = 1; });`], { cwd: first, encoding: "utf8" });
    assert.ifError(run.error);
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
});

it("keeps architecture boundaries for $infra imports", () => {
    const root = fixture();
    write(root, "app/infra/config.ts", 'export const label = "stored";');
    for (const file of ["app/http/bad/get.ts", "app/http/+middleware.ts", "app/web/client/bad.ts", "app/web/server/bad.ts", "app/modules/shared/schemas.ts"]) {
        write(root, file, 'import { label } from "$infra/config"; export const handler = () => label;');
    }
    const project = analyzeProject(root, "app/http");
    for (const [file, code] of [["app/http/bad/get.ts", "BORING101"], ["app/http/+middleware.ts", "BORING101"],
        ["app/web/client/bad.ts", "BORING105"], ["app/web/server/bad.ts", "BORING109"], ["app/modules/shared/schemas.ts", "BORING105"]]) {
        assert.ok(project.architecture.some(error => error.file.fileName === join(root, file) && error.code === code), `${file}: ${code}`);
    }
});

it("rejects missing, redirected and traversing $infra mappings", () => {
    const root = fixture();
    write(root, "app/infra/config.ts", 'export const label = "stored";');
    const source = join(root, "app/infra/read.ts");
    writeFileSync(source, 'export { label } from "$infra/config";');
    const file = join(root, "tsconfig.json");
    const configuration = JSON.parse(readFileSync(file, "utf8"));
    configuration.compilerOptions.paths = { "$modules/*": ["app/modules/*"] };
    for (const redirected of [false, true]) {
        if (redirected) {
            configuration.compilerOptions.paths["$infra/*"] = ["app/infra/*"];
            configuration.compilerOptions.paths["$infra/config"] = ["app/modules/orders/schemas.ts"];
        }
        writeFileSync(file, JSON.stringify(configuration));
        const project = analyzeProject(root, "app/http");
        const errors = project.diagnostics.filter(error => String(error.messageText).includes("BORING108"));
        assert.equal(errors.length, 1);
        assert.equal(errors[0].file?.fileName, source);
        assert.match(String(errors[0].messageText), /\$infra.*sibling infra/);
        assert.equal(project.program.getCompilerOptions().paths!["$infra/config"], undefined);
    }
    delete configuration.compilerOptions.paths["$infra/config"];
    writeFileSync(file, JSON.stringify(configuration));
    checked(root);
    for (const path of ["$infra", "$infra/../modules/orders/schemas"]) {
        writeFileSync(source, `export { label } from "${path}";`);
        assert.ok(analyzeProject(root, "app/http").diagnostics.some(error => String(error.messageText).includes("Invalid $infra import")));
        const stop = registerTypeScript(join(root, "app/http"));
        try { assert.throws(() => require(source), /BORING108: Invalid \$infra import/); }
        finally { stop(); }
    }
});

it("resolves $client through generated editor paths and relocates its emitted declarations", () => {
    const root = fixture();
    write(root, "app/web/client/api.ts", `import type { ApiRoutes } from "$client";
        export const label = (order: ApiRoutes["GET /orders/:id"]["output"]): string => order.label;
        export type Routes = ApiRoutes;
        export type { ApiRoutes } from "$client";
        export type ImportedRoutes = import("$client").ApiRoutes;`);
    write(root, "app/web/client/pages/orders/page.ts", `import type { ApiRoutes } from "$client";
        export type Order = ApiRoutes["GET /orders/:id"]["output"];
        export const label = (order: Order): string => order.label;`);
    const project = checked(root);
    const configuration = readConfiguration(root);
    assert.deepEqual(configuration.options.paths!["$client"], [".boring/types/app/http/$client.d.ts"]);
    const editor = ts.createProgram(configuration.fileNames, configuration.options);
    const diagnostics = ts.getPreEmitDiagnostics(editor);
    assert.equal(diagnostics.length, 0, ts.formatDiagnostics(diagnostics, formatHost(root)));
    assert.equal(ts.resolveModuleName("$client", join(root, "app/web/client/pages/orders/page.ts"), configuration.options, ts.sys)
        .resolvedModule?.resolvedFileName, project.clientFile);

    assert.deepEqual(buildProject(project).diagnostics.map(error => ts.flattenDiagnosticMessageText(error.messageText, "\n")), []);
    renameSync(join(root, "output"), join(root, "deployed"));
    const api = join(root, "deployed/web/client/api");
    assert.doesNotMatch(readFileSync(`${api}.js`, "utf8"), /\$client/);
    assert.doesNotMatch(readFileSync(`${api}.d.ts`, "utf8"), /["']\$client["']/);
    assert.ok(existsSync(join(root, "deployed/http/$client.d.ts")));
    const deployed = ts.createProgram([`${api}.d.ts`, join(root, "deployed/web/client/pages/orders/page.d.ts")], {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true, strict: true, noEmit: true,
    });
    const errors = ts.getPreEmitDiagnostics(deployed);
    assert.equal(errors.length, 0, ts.formatDiagnostics(errors, formatHost(root)));
    assert.ok(!deployed.getSourceFiles().some(file => file.fileName.startsWith(join(root, "app")) || file.fileName.startsWith(join(root, ".boring"))));
});

it("provides path/member completion, hover, definitions, rename and alias auto-imports through the ordinary TS language service", () => {
    const root = fixture();
    generateTypes(root, "app/http");
    const file = join(root, "app/editor.ts");
    const text = 'import { order } from "$modules/orders/schemas";\norder.parse({ id: "1", label: "ok" });\norderParams;\nimport "$modules/orders/";\n';
    writeFileSync(file, text);
    const config = readConfiguration(root);
    const service = ts.createLanguageService({
        getCompilationSettings: () => config.options,
        getScriptFileNames: () => config.fileNames,
        getScriptVersion: () => "1",
        getScriptSnapshot: name => { const text = ts.sys.readFile(name); return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text); },
        getCurrentDirectory: () => root,
        getDefaultLibFileName: options => ts.getDefaultLibFilePath(options),
        fileExists: ts.sys.fileExists, readFile: ts.sys.readFile, readDirectory: ts.sys.readDirectory,
        directoryExists: ts.sys.directoryExists, getDirectories: ts.sys.getDirectories,
    });
    try {
        const usage = text.indexOf("order.parse");
        const definition = service.getDefinitionAtPosition(file, usage)!;
        assert.ok(definition.some(entry => entry.fileName === join(root, "app/modules/orders/schemas.ts")));
        assert.match(ts.displayPartsToString(service.getQuickInfoAtPosition(file, usage)!.displayParts), /ZodObject/);
        assert.ok(service.getCompletionsAtPosition(file, usage + "order.".length, {})!.entries.some(entry => entry.name === "parse"));
        const renamed = service.findRenameLocations(join(root, "app/modules/orders/schemas.ts"), readFileSync(join(root, "app/modules/orders/schemas.ts"), "utf8").indexOf("order ="), false, false)!;
        assert.ok(renamed.some(entry => entry.fileName.endsWith("get.ts")));
        const preferences: ts.UserPreferences = { includeCompletionsForModuleExports: true, includeCompletionsWithInsertText: true, importModuleSpecifierPreference: "non-relative" };
        const completions = service.getCompletionsAtPosition(file, text.indexOf("orderParams;") + "orderParams".length, preferences)!;
        const entry = completions.entries.find(entry => entry.name === "orderParams" && entry.source)!;
        assert.ok(entry, "schema export should be offered as an auto-import");
        const details = service.getCompletionEntryDetails(file, text.indexOf("orderParams;") + "orderParams".length, entry.name, {}, entry.source, preferences, entry.data)!;
        assert.match(JSON.stringify(details.codeActions), /orderParams/);
        assert.match(JSON.stringify(details.codeActions), /\$modules\/orders\/schemas/);
        const paths = service.getCompletionsAtPosition(file, text.lastIndexOf('$modules/orders/') + '$modules/orders/'.length, {})!;
        assert.ok(paths.entries.some(entry => entry.name === "schemas"), JSON.stringify(paths.entries));
        assert.ok(!service.getSemanticDiagnostics(file).some(error => error.code === 2307 && String(error.messageText).includes("orders/schemas")));
    } finally { service.dispose(); }
});

it("uses the source compiler for custom servers and keeps two applications' aliases separate", async () => {
    const first = fixture();
    const second = fixture();
    generateTypes(first, "app/http");
    generateTypes(second, "app/http");
    const path = "app/modules/orders/schemas.ts";
    writeFileSync(join(second, path), readFileSync(join(second, path), "utf8").replace('"aliased"', '"second"'));
    const stopFirst = registerTypeScript(join(first, "app/http"));
    const stopSecond = registerTypeScript(join(second, "app/http"));
    try {
        const a = require(join(first, "app/infra/loading.ts"));
        const b = require(join(second, "app/infra/loading.ts"));
        assert.equal(await a.lazy(), "aliased");
        assert.equal(a.required(), "aliased");
        assert.equal(a.equals(), "aliased");
        assert.equal(a.moduleRequired(), "aliased");
        assert.equal(a.bracketRequired(), "aliased");
        assert.equal(a.shadowed((text: string) => text), "$modules/not/a/module");
        assert.equal(a.localScopes(), "aliased");
        assert.equal(a.methods.require(), "aliased");
        assert.equal(b.required(), "second");
        const { BoringApi } = require("@boringapi/core");
        assert.ok(await new BoringApi().createApp(join(first, "app/http")));
    } finally { stopSecond(); stopFirst(); }
});

it("loads JavaScript companions instead of their declarations in the source compiler", async () => {
    const root = fixture();
    write(root, "app/modules/legacy/schemas.js", 'exports.label = "javascript";');
    write(root, "app/modules/legacy/schemas.d.ts", 'export declare const label: string;');
    write(root, "app/infra/legacy/value.cjs", 'exports.label = "commonjs";');
    write(root, "app/infra/legacy/value.d.cts", 'export declare const label: string;');
    write(root, "app/infra/legacy/loading.ts", [
        'import { label } from "$modules/legacy/schemas";',
        'export const read = () => label;',
        'export const lazy = async () => (await import("$modules/legacy/schemas")).label;',
        'export const required = () => require("$modules/legacy/schemas").label;',
        'export const commonjs = () => require("$infra/legacy/value.cjs").label;',
    ].join("\n"));
    write(root, "app/http/legacy/get.ts", 'import { label } from "$modules/legacy/schemas"; export const handler = () => label;');
    checked(root);
    const stop = registerTypeScript(join(root, "app/http"));
    try {
        const facade = require(join(root, "app/infra/legacy/loading.ts"));
        assert.equal(facade.read(), "javascript");
        assert.equal(await facade.lazy(), "javascript");
        assert.equal(facade.required(), "javascript");
        assert.equal(facade.commonjs(), "commonjs");
        assert.equal(require(join(root, "app/http/legacy/get.ts")).handler(), "javascript");
    } finally { stop(); }
    assert.deepEqual(buildProject(checked(root)).diagnostics.map(error => ts.flattenDiagnosticMessageText(error.messageText, "\n")), []);
    const run = spawnSync(process.execPath, ["-e", [
        'const assert = require("node:assert/strict");',
        'const facade = require("./output/infra/legacy/loading.js");',
        'assert.equal(facade.read(), "javascript");',
        'assert.equal(facade.commonjs(), "commonjs");',
    ].join("\n")], { cwd: root, encoding: "utf8" });
    assert.ifError(run.error);
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
});

it("rewrites nested import types in emitted and copied declarations", () => {
    const root = fixture();
    const schemas = join(root, "app/modules/orders/schemas.ts");
    writeFileSync(schemas, `${readFileSync(schemas, "utf8")}\nexport type Box<T> = { value: T };`);
    const nested = 'export type Nested = import("./schemas").Box<import("$modules/orders/schemas").Box<import("$modules/orders/schemas").Order>>;';
    const facade = join(root, "app/modules/orders/facade.ts");
    writeFileSync(facade, `${readFileSync(facade, "utf8")}\n${nested}`);
    write(root, "app/modules/orders/schemas/nested.d.ts", nested.replace('"./schemas"', '"../schemas"'));
    assert.deepEqual(buildProject(checked(root)).diagnostics.map(error => ts.flattenDiagnosticMessageText(error.messageText, "\n")), []);
    const files = ["facade.d.ts", "schemas/nested.d.ts"].map(file => join(root, "output/modules/orders", file));
    for (const file of files) assert.ok(!readFileSync(file, "utf8").includes("$modules"));
    const declarations = ts.createProgram(files, {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true, strict: true, noEmit: true,
    });
    const diagnostics = ts.getPreEmitDiagnostics(declarations);
    assert.equal(diagnostics.length, 0, ts.formatDiagnostics(diagnostics, formatHost(root)));
    assert.ok(!declarations.getSourceFiles().some(file => file.fileName.startsWith(join(root, "app"))));
});

it("can rebuild into the default output directory without ingesting the previous build", () => {
    const root = fixture();
    const configFile = join(root, "tsconfig.json");
    const config = JSON.parse(readFileSync(configFile, "utf8"));
    delete config.compilerOptions.outDir;
    delete config.include;
    writeFileSync(configFile, JSON.stringify(config));
    assert.deepEqual(buildProject(checked(root)).diagnostics.map(error => ts.flattenDiagnosticMessageText(error.messageText, "\n")), []);
    assert.ok(existsSync(join(root, "dist/http/orders/[id]/get.js")));
    rmSync(join(root, "app/http/orders"), { recursive: true });
    write(root, "app/http/get.ts", 'export const handler = () => "rebuilt";');
    const second = checked(root);
    assert.ok(!second.program.getSourceFiles().some(file => file.fileName.startsWith(join(root, "dist"))));
    assert.deepEqual(buildProject(second).diagnostics.map(error => ts.flattenDiagnosticMessageText(error.messageText, "\n")), []);
    assert.equal(existsSync(join(root, "dist/http/orders")), false);
    assert.ok(existsSync(join(root, "dist/http/get.js")));
});

it("uses the emitted JSX extension for aliases with JSX preserved or transformed", () => {
    for (const jsx of ["preserve", "react"]) {
        const root = fixture();
        const configFile = join(root, "tsconfig.json");
        const config = JSON.parse(readFileSync(configFile, "utf8"));
        config.compilerOptions.jsx = jsx;
        writeFileSync(configFile, JSON.stringify(config));
        write(root, "app/infra/view/schemas.tsx", 'export const label = "tsx";');
        write(root, "app/infra/view/internal/value.jsx", 'export const label = "jsx";');
        write(root, "app/infra/view/internal/typed.jsx", 'exports.label = "typed-jsx";');
        write(root, "app/infra/view/internal/typed.d.ts", 'export declare const label: string;');
        write(root, "app/infra/view/facade.ts", [
            'export { label as tsx } from "$infra/view/schemas";',
            'export { label as jsx } from "$infra/view/internal/value";',
            'export { label as typed } from "$infra/view/internal/typed";',
        ].join("\n"));
        const project = checked(root);
        const stop = registerTypeScript(join(root, "app/http"));
        try {
            const facade = require(join(root, "app/infra/view/facade.ts"));
            assert.equal(facade.tsx, "tsx");
            assert.equal(facade.jsx, "jsx");
            assert.equal(facade.typed, "typed-jsx");
        } finally { stop(); }
        assert.deepEqual(buildProject(project).diagnostics.map(error => ts.flattenDiagnosticMessageText(error.messageText, "\n")), []);
        const extension = jsx === "preserve" ? "jsx" : "js";
        assert.ok(existsSync(join(root, `output/infra/view/schemas.${extension}`)));
        const declarations = ts.createProgram([join(root, "output/infra/view/facade.d.ts")], {
            module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, strict: true, noEmit: true,
        });
        const diagnostics = ts.getPreEmitDiagnostics(declarations);
        assert.equal(diagnostics.length, 0, ts.formatDiagnostics(diagnostics, formatHost(root)));
        const run = spawnSync(process.execPath, ["-e", [
            'const assert = require("node:assert/strict");',
            'const facade = require("./output/infra/view/facade.js");',
            'assert.equal(facade.tsx, "tsx");',
            'assert.equal(facade.jsx, "jsx");',
            'assert.equal(facade.typed, "typed-jsx");',
        ].join("\n")], { cwd: root, encoding: "utf8" });
        assert.ifError(run.error);
        assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    }
});

it("builds portable CommonJS with working declarations and removes stale routes only after a successful build", () => {
    const root = fixture();
    write(root, "app/http/+setup.ts", [
        'import type { SetupContext } from "./$types";',
        'import { createOrders } from "$modules/orders/facade";',
        'export function setup(_ctx: SetupContext) { return { orders: createOrders() }; }',
    ].join("\n"));
    write(root, "app/http/+auth.ts", [
        'import type { AuthenticationContext, AuthorizationContext } from "./$types";',
        'export function authenticate(ctx: AuthenticationContext) { return { kind: "user" as const, id: "test", permissions: [], user: ctx.services.orders.read("user") }; }',
        'export function authorize(ctx: AuthorizationContext, _rule: "read"): void { ctx.session.user.id.toUpperCase(); }',
    ].join("\n"));
    write(root, "app/http/+middleware.ts", [
        'import type { MiddlewareContext } from "./$types";',
        'export function handler(ctx: MiddlewareContext) { return { requestId: ctx.session?.user.id ?? "request" }; }',
    ].join("\n"));
    const project = checked(root);
    const built = buildProject(project);
    assert.deepEqual(built.diagnostics.map(error => ts.flattenDiagnosticMessageText(error.messageText, "\n")), []);
    const output = join(root, "output");
    const route = readFileSync(join(output, "http/orders/[id]/get.js"), "utf8");
    assert.match(route, /require\("\.\.\/\.\.\/\.\.\/modules\/orders\/schemas.js"\)/);
    assert.ok(!route.includes("$modules"));
    const script = [
        'const assert = require("node:assert/strict");',
        'const facade = require("./output/infra/loading.js");',
        'assert.equal(facade.required(), "aliased");',
        'assert.equal(facade.equals(), "aliased");',
        'assert.equal(facade.moduleRequired(), "aliased");',
        'assert.equal(facade.bracketRequired(), "aliased");',
        'assert.equal(facade.localScopes(), "aliased");',
        'assert.equal(facade.methods.require(), "aliased");',
        'facade.lazy().then(value => assert.equal(value, "aliased"));',
        'const { BoringApi } = require("@boringapi/core");',
        'new BoringApi().createApp(require("node:path").resolve("output/http")).then(app => {',
        '  const server = app.http.listen(0, "127.0.0.1", async () => {',
        '    try { const response = await fetch(`http://127.0.0.1:${server.address().port}/orders/42`);',
        '      assert.equal(response.status, 200); assert.deepEqual(await response.json(), { id: "42", label: "aliased" });',
        '    } finally { server.close(); }',
        '  });',
        '});',
    ].join("\n");
    const run = spawnSync(process.execPath, ["-e", script], { cwd: root, encoding: "utf8" });
    assert.ifError(run.error);
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    const declarations = ts.createProgram([join(output, "http/orders/[id]/get.d.ts"), join(output, "modules/orders/facade.d.ts")], {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true, strict: true, noEmit: true,
    });
    assert.equal(ts.getPreEmitDiagnostics(declarations).length, 0, ts.formatDiagnostics(ts.getPreEmitDiagnostics(declarations), formatHost(root)));
    assert.ok(!declarations.getSourceFiles().some(file => file.fileName.startsWith(join(root, "app"))));
    assert.ok(existsSync(join(output, "modules/orders/schemas/model.d.ts")));
    const map = JSON.parse(readFileSync(join(output, "http/orders/[id]/get.js.map"), "utf8"));
    assert.ok(map.sources[0].endsWith("app/http/orders/[id]/get.ts"));
    rmSync(join(root, "app/http/orders"), { recursive: true });
    write(root, "app/http/get.ts", 'export const handler = () => "root";');
    assert.deepEqual(buildProject(checked(root)).diagnostics.map(error => ts.flattenDiagnosticMessageText(error.messageText, "\n")), []);
    assert.equal(existsSync(join(output, "http/orders")), false);
    write(root, "app/http/get.ts", 'export const handler = 42;');
    assert.throws(() => buildProject(analyzeProject(root, "app/http")), /check errors/);
    assert.ok(existsSync(join(output, "http/get.js")));
});

it("refuses source, external, symlinked and unowned build output", () => {
    const root = fixture();
    const project = checked(root);
    for (const directory of [root, join(root, "app"), suite]) {
        project.configuration.options.outDir = directory;
        assert.throws(() => buildProject(project), /inside|overlaps/);
    }
    const external = join(suite, "external");
    mkdirSync(external);
    symlinkSync(external, join(root, "linked"), "dir");
    project.configuration.options.outDir = join(root, "linked/output");
    assert.throws(() => buildProject(project), /symbolic/);
    project.configuration.options.outDir = join(root, "output");
    write(root, "output/KEEP", "unrelated");
    assert.throws(() => buildProject(project), /not owned/);
    assert.equal(readFileSync(join(root, "output/KEEP"), "utf8"), "unrelated");
});
