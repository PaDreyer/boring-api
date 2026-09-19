import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import ts from "typescript";
import { generateTypes } from "../src/core/typegen";
import { analyzeProject, formatHost } from "../src/core/project";
import { readConfiguration } from "../src/core/config";
import { buildProject } from "../src/core/build";
import { inspectProject } from "../src/core/inspect";
import { registerTypeScript } from "../src/register";

const { before, after } = require("node:test");
const repository = join(__dirname, "..");
const suite = mkdtempSync(join(tmpdir(), "boring-aliases-"));
const library = join(suite, "library");
function write(root: string, file: string, content: string) {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
}
before(() => {
    const config = readConfiguration(repository);
    const program = ts.createProgram(config.fileNames, { ...config.options, outDir: library });
    const result = program.emit();
    assert.equal(result.emitSkipped, false);
    write(library, "package.json", JSON.stringify({ name: "@boringapi/core", main: "index.js", types: "index.d.ts" }));
    symlinkSync(join(repository, "node_modules"), join(library, "node_modules"), "dir");
});
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
    write(root, "app/modules/orders/internal/read.ts", [
        'import type { Order } from "$modules/orders/schemas";',
        'export const read = (id: string): Order => ({ id, label: "aliased" });',
    ].join("\n"));
    write(root, "app/modules/orders/internal/model.d.ts", 'export interface Metadata { label: string; }');
    write(root, "app/modules/orders/internal/equals.ts", 'import schemas = require("$modules/orders/schemas"); export const equals = () => schemas.label;');
    write(root, "app/modules/orders/facade.ts", [
        'import { read } from "$modules/orders/internal/read";',
        'export { read } from "$modules/orders/internal/read";',
        'export type { Order } from "$modules/orders/schemas";',
        'export type OrderImport = import("$modules/orders/schemas").Order;',
        'export type { Metadata } from "./internal/model";',
        'export { equals } from "./internal/equals";',
        'export const createOrders = () => ({ read });',
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
    assert.deepEqual(project.architecture, []);
    return project;
}

it("checks and inspects aliases, including unused modules, without executing source", () => {
    const root = fixture();
    write(root, "app/modules/unused/facade.ts", 'throw new Error("must not execute"); export const run = () => "ok";');
    const project = checked(root);
    const catalog = inspectProject(project);
    assert.equal(catalog.services[0].operations[0].access, "ctx.services.orders.read");
    assert.equal(catalog.modules.find(module => module.name === "unused")!.facade!.exports[0].name, "run");
    write(root, "app/modules/unused/facade.ts", 'import { read } from "$modules/orders/internal/read"; export { read };');
    assert.ok(analyzeProject(root, "app/http").architecture.some(error => error.code === "BORING102"));
    write(root, "app/modules/unused/facade.ts", 'export const bad = () => import("$modules/missing/schemas");');
    assert.ok(analyzeProject(root, "app/http").architecture.some(error => error.code === "BORING106"));
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
    write(root, "app/http/orders/[id]/get.ts", 'import { read } from "$modules/../modules/orders/internal/read"; export const handler = read;');
    assert.ok(analyzeProject(root, "app/http").diagnostics.some(error => String(error.messageText).includes("BORING108")));
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
        const a = require(join(first, "app/modules/orders/facade.ts"));
        const b = require(join(second, "app/modules/orders/facade.ts"));
        assert.equal(await a.lazy(), "aliased");
        assert.equal(a.required(), "aliased");
        assert.equal(a.equals(), "aliased");
        assert.equal(a.moduleRequired(), "aliased");
        assert.equal(a.bracketRequired(), "aliased");
        assert.equal(a.shadowed((text: string) => text), "$modules/not/a/module");
        assert.equal(a.localScopes(), "aliased");
        assert.equal(a.methods.require(), "aliased");
        assert.equal(b.required(), "second");
        const { BoringApi } = require(join(library, "index.js"));
        assert.ok(await new BoringApi().createApp(join(first, "app/http")));
    } finally { stopSecond(); stopFirst(); }
});

it("loads JavaScript companions instead of their declarations in the source compiler", async () => {
    const root = fixture();
    write(root, "app/modules/legacy/schemas.js", 'exports.label = "javascript";');
    write(root, "app/modules/legacy/schemas.d.ts", 'export declare const label: string;');
    write(root, "app/modules/legacy/internal/value.cjs", 'exports.label = "commonjs";');
    write(root, "app/modules/legacy/internal/value.d.cts", 'export declare const label: string;');
    write(root, "app/modules/legacy/facade.ts", [
        'import { label } from "$modules/legacy/schemas";',
        'export const read = () => label;',
        'export const lazy = async () => (await import("$modules/legacy/schemas")).label;',
        'export const required = () => require("$modules/legacy/schemas").label;',
        'export const commonjs = () => require("$modules/legacy/internal/value.cjs").label;',
    ].join("\n"));
    write(root, "app/http/legacy/get.ts", 'import { label } from "$modules/legacy/schemas"; export const handler = () => label;');
    checked(root);
    const stop = registerTypeScript(join(root, "app/http"));
    try {
        const facade = require(join(root, "app/modules/legacy/facade.ts"));
        assert.equal(facade.read(), "javascript");
        assert.equal(await facade.lazy(), "javascript");
        assert.equal(facade.required(), "javascript");
        assert.equal(facade.commonjs(), "commonjs");
        assert.equal(require(join(root, "app/http/legacy/get.ts")).handler(), "javascript");
    } finally { stop(); }
    assert.deepEqual(buildProject(checked(root)).diagnostics, []);
    const run = spawnSync(process.execPath, ["-e", [
        'const assert = require("node:assert/strict");',
        'const facade = require("./output/modules/legacy/facade.js");',
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
    write(root, "app/modules/orders/nested.d.ts", nested);
    assert.deepEqual(buildProject(checked(root)).diagnostics, []);
    const files = ["facade.d.ts", "nested.d.ts"].map(file => join(root, "output/modules/orders", file));
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
    assert.deepEqual(buildProject(checked(root)).diagnostics, []);
    assert.ok(existsSync(join(root, "dist/http/orders/[id]/get.js")));
    rmSync(join(root, "app/http/orders"), { recursive: true });
    write(root, "app/http/get.ts", 'export const handler = () => "rebuilt";');
    const second = checked(root);
    assert.ok(!second.program.getSourceFiles().some(file => file.fileName.startsWith(join(root, "dist"))));
    assert.deepEqual(buildProject(second).diagnostics, []);
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
        write(root, "app/modules/view/schemas.tsx", 'export const label = "tsx";');
        write(root, "app/modules/view/internal/value.jsx", 'export const label = "jsx";');
        write(root, "app/modules/view/internal/typed.jsx", 'exports.label = "typed-jsx";');
        write(root, "app/modules/view/internal/typed.d.ts", 'export declare const label: string;');
        write(root, "app/modules/view/facade.ts", [
            'export { label as tsx } from "$modules/view/schemas";',
            'export { label as jsx } from "$modules/view/internal/value";',
            'export { label as typed } from "$modules/view/internal/typed";',
        ].join("\n"));
        const project = checked(root);
        const stop = registerTypeScript(join(root, "app/http"));
        try {
            const facade = require(join(root, "app/modules/view/facade.ts"));
            assert.equal(facade.tsx, "tsx");
            assert.equal(facade.jsx, "jsx");
            assert.equal(facade.typed, "typed-jsx");
        } finally { stop(); }
        assert.deepEqual(buildProject(project).diagnostics, []);
        const extension = jsx === "preserve" ? "jsx" : "js";
        assert.ok(existsSync(join(root, `output/modules/view/schemas.${extension}`)));
        const declarations = ts.createProgram([join(root, "output/modules/view/facade.d.ts")], {
            module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, strict: true, noEmit: true,
        });
        const diagnostics = ts.getPreEmitDiagnostics(declarations);
        assert.equal(diagnostics.length, 0, ts.formatDiagnostics(diagnostics, formatHost(root)));
        const run = spawnSync(process.execPath, ["-e", [
            'const assert = require("node:assert/strict");',
            'const facade = require("./output/modules/view/facade.js");',
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
        'export function authenticate(ctx: AuthenticationContext) { return { user: ctx.services.orders.read("user") }; }',
        'export function authorize(ctx: AuthorizationContext, _rule: "read"): void { ctx.session.user.id.toUpperCase(); }',
    ].join("\n"));
    write(root, "app/http/+middleware.ts", [
        'import type { MiddlewareContext } from "./$types";',
        'export function handler(ctx: MiddlewareContext) { return { requestId: ctx.session?.user.id ?? "request" }; }',
    ].join("\n"));
    const project = checked(root);
    const built = buildProject(project);
    assert.deepEqual(built.diagnostics, []);
    const output = join(root, "output");
    const route = readFileSync(join(output, "http/orders/[id]/get.js"), "utf8");
    assert.match(route, /require\("\.\.\/\.\.\/\.\.\/modules\/orders\/schemas.js"\)/);
    assert.ok(!route.includes("$modules"));
    const script = [
        'const assert = require("node:assert/strict");',
        'const facade = require("./output/modules/orders/facade.js");',
        'assert.equal(facade.required(), "aliased");',
        'assert.equal(facade.equals(), "aliased");',
        'assert.equal(facade.moduleRequired(), "aliased");',
        'assert.equal(facade.bracketRequired(), "aliased");',
        'assert.equal(facade.localScopes(), "aliased");',
        'assert.equal(facade.methods.require(), "aliased");',
        'facade.lazy().then(value => assert.equal(value, "aliased"));',
        'const { BoringApi } = require("@boringapi/core");',
        'new BoringApi().createApp(require("node:path").resolve("output/http")).then(app => {',
        '  const server = app.listen(0, "127.0.0.1", async () => {',
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
    assert.ok(existsSync(join(output, "modules/orders/internal/model.d.ts")));
    const map = JSON.parse(readFileSync(join(output, "http/orders/[id]/get.js.map"), "utf8"));
    assert.ok(map.sources[0].endsWith("app/http/orders/[id]/get.ts"));
    rmSync(join(root, "app/http/orders"), { recursive: true });
    write(root, "app/http/get.ts", 'export const handler = () => "root";');
    assert.deepEqual(buildProject(checked(root)).diagnostics, []);
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
