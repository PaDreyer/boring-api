import { formatHost } from "@boringapi/compiler";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import ts from "typescript";
import { buildProject } from "@boringapi/build";
import { inspectProject } from "@boringapi/analyzer";
import { analyzeProject } from "@boringapi/analyzer";
import { addEndpoint, addModule, initializeProject } from "../src";

const { after } = require("node:test");
const repository = join(__dirname, "..");
const suite = mkdtempSync(join(tmpdir(), "boring-scaffold-"));
const library = dirname(require.resolve("@boringapi/core/package.json"));
function write(root: string, file: string, content: string) {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
}
after(() => rmSync(suite, { recursive: true, force: true }));

function fresh() { return mkdtempSync(join(suite, "consumer-")); }
function dependencies(root: string) {
    mkdirSync(join(root, "node_modules/@boringapi"), { recursive: true });
    symlinkSync(library, join(root, "node_modules/@boringapi/core"), "dir");
    symlinkSync(join(repository, "node_modules/zod"), join(root, "node_modules/zod"), "dir");
    symlinkSync(join(repository, "node_modules/@types"), join(root, "node_modules/@types"), "dir");
}
function fixture(api = "api") {
    const root = fresh();
    initializeProject(root, api);
    dependencies(root);
    return root;
}
function checked(root: string, api = "api", projectFile?: string) {
    const result = analyzeProject(root, api, projectFile);
    assert.equal(result.diagnostics.length, 0, ts.formatDiagnostics(result.diagnostics, formatHost(root)));
    assert.deepEqual(result.architecture.map(error => error.message), []);
    return result;
}
function orders(root: string) {
    write(root, "api/+setup.ts", 'import type { SetupContext } from "./$types"; import { createOrders } from "$modules/orders/facade"; import { createHealth } from "$modules/health/facade"; export const setup = (_ctx: SetupContext) => ({ orders: createOrders(), health: createHealth() });');
    write(root, "api/+auth.ts", [
        'import { requirePermissions } from "@boringapi/core";',
        'import type { AuthenticationContext, AuthorizationContext } from "./$types";',
        'export const authenticate = (_ctx: AuthenticationContext) => ({ kind: "user" as const, id: "fixture", permissions: ["orders:read"] as const });',
        'export const authorize = (ctx: AuthorizationContext, rule: "orders:read") => requirePermissions(ctx.session.permissions, rule);',
    ].join("\n"));
    write(root, "modules/orders/schemas.ts", 'import { z } from "zod"; export const order = z.object({ id: z.string() }); export const orderParams = order.pick({ id: true }); export type Order = z.infer<typeof order>;');
    write(root, "modules/orders/facade.ts", [
        'import { requirePermissions } from "@boringapi/core";',
        'import type { Order } from "./schemas";',
        'export function createOrders() { return { get({ id, actor }: { id: string; actor: { permissions: readonly "orders:read"[] } }): Order { requirePermissions(actor.permissions, "orders:read"); return { id }; } }; }',
        'throw new Error("Generator must not execute facades");',
    ].join("\n"));
    write(root, "api/orders/+middleware.ts", 'import type { MiddlewareContext } from "./$types"; export const handler = (_ctx: MiddlewareContext) => ({ section: "orders" });');
    write(root, "api/orders/+error.404.ts", 'import type { ErrorContext } from "./$types"; export const handler = (_ctx: ErrorContext) => ({ error: "Missing order" });');
    write(root, "api/orders/[id]/get.ts", [
        'import { order, orderParams } from "$modules/orders/schemas";',
        'import type { GetHandler } from "./$types";',
        'export const params = orderParams;',
        'export const output = order;',
        'export const authorization = "orders:read";',
        'export const handler: GetHandler = ctx => ctx.services.orders.get({ id: ctx.params.id, actor: ctx.session });',
    ].join("\n"));
}

it("initializes default and nested consumers with typed hooks, editor shortcuts and checked builds", () => {
    for (const api of ["api", "src/http"]) {
        const root = fixture(api);
        const project = checked(root, api);
        const catalog = inspectProject(project);
        assert.equal(catalog.services[0].operations[0].access, "ctx.services.health.get");
        assert.ok(catalog.roles.some(source => source.role === "service" && source.module === "health"));
        assert.equal(catalog.routes[0].path, "/health");
        assert.equal(catalog.setup!.file, `${api}/+setup.ts`);
        assert.match(readFileSync(join(root, api, "+setup.ts"), "utf8"), /SetupContext.*from "\.\/\$types"/);
        const editor = JSON.parse(readFileSync(join(root, ".boring/tsconfig.json"), "utf8"));
        assert.deepEqual(editor.compilerOptions.paths["$modules/*"], [api === "api" ? "modules/*" : "src/modules/*"]);
        assert.deepEqual(editor.compilerOptions.paths["$infra/*"], [api === "api" ? "infra/*" : "src/infra/*"]);
        const built = buildProject(project);
        assert.deepEqual(built.diagnostics.map(error => ts.flattenDiagnosticMessageText(error.messageText, "\n")), []);
        assert.ok(existsSync(join(built.output, api === "api" ? "api/health/get.js" : "http/health/get.js")));
        const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
        assert.equal(manifest.scripts.start, "node dist/boring-start.cjs");
        assert.ok(manifest.devDependencies["@boringapi/cli"]);
        assert.equal(manifest.dependencies["@boringapi/cli"], undefined);
        assert.ok(manifest.dependencies["@boringapi/core"]);
        assert.match(manifest.dependencies.zod, /3\./);
        const instructions = readFileSync(join(root, "AGENTS.md"), "utf8");
        const locator = instructions.match(/^node -p "([^"]+)"$/m);
        assert.ok(locator, "Generated instructions must locate the installed agent guide");
        const located = spawnSync(process.execPath, ["-p", locator[1]], { cwd: root, encoding: "utf8" });
        assert.equal(located.status, 0, located.stderr);
        assert.equal(located.stdout.trim(), join(library, "docs/agent-guide.md"));
        assert.ok(instructions.includes(`\`${api}/+setup.ts\``));
        assert.ok(instructions.includes(`\`${api === "api" ? "web/client" : "src/web/client"}/\``));
    }
});

it("refuses generators when setup exposes raw infrastructure directly or through setter aliases", () => {
    const root = fixture();
    write(root, "infra/store.ts", 'export const store = { read() { return "raw"; } };');
    for (const setup of [
        'export const setup = () => ({ store });',
        'export function setup(ctx: SetupContext) { const { assign } = ctx; assign.call(ctx, { raw: store }); }',
    ]) {
        write(root, "api/+setup.ts", `import type { SetupContext } from "@boringapi/core"; import { store } from "$infra/store"; ${setup}`);
        assert.throws(() => addModule(root, "api", "invoices"), /BORING113/);
        assert.throws(() => addEndpoint(root, "api", "invoices/get"), /BORING113/);
        assert.equal(existsSync(join(root, "modules/invoices")), false);
        assert.equal(existsSync(join(root, "api/invoices")), false);
    }
});

it("merges installed dependencies and unrelated scripts, but preflights all collisions before writing", () => {
    const root = fresh();
    write(root, "package.json", JSON.stringify({ name: "existing", scripts: { lint: "custom-lint" }, dependencies: { "@boringapi/core": "file:../core", zod: "3.25.76" } }));
    initializeProject(root);
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    assert.equal(manifest.name, "existing");
    assert.equal(manifest.scripts.lint, "custom-lint");
    assert.equal(manifest.dependencies["@boringapi/core"], "file:../core");
    assert.equal(manifest.dependencies.zod, "3.25.76");
    for (const [file, content] of [["README.md", "My existing docs"], ["tsconfig.json", "{}"], ["package.json", '{"scripts":{"test":"existing-tests"}}']]) {
        const conflict = fresh();
        write(conflict, file, content);
        assert.throws(() => initializeProject(conflict), /Refusing to/);
        assert.equal(readFileSync(join(conflict, file), "utf8"), content);
        assert.equal(existsSync(join(conflict, "api")), false);
        if (file !== "package.json") assert.equal(existsSync(join(conflict, "package.json")), false);
    }
    assert.throws(() => initializeProject(root), /already exists/);
});

it("keeps an existing CLI version only in devDependencies and rejects conflicting versions before writing", () => {
    for (const alreadyDevelopment of [false, true]) {
        const root = fresh();
        write(root, "package.json", JSON.stringify({ name: "existing",
            dependencies: { "@boringapi/cli": "file:../cli" },
            devDependencies: { ...(alreadyDevelopment ? { "@boringapi/cli": "file:../cli" } : {}), lint: "1.0.0" },
        }));
        const result = initializeProject(root);
        const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
        assert.equal(manifest.dependencies["@boringapi/cli"], undefined);
        assert.equal(manifest.devDependencies["@boringapi/cli"], "file:../cli");
        assert.equal(manifest.devDependencies.lint, "1.0.0");
        assert.match(result.notes.join("\n"), /Moved @boringapi\/cli to devDependencies/);
    }
    const root = fresh();
    const manifest = JSON.stringify({ dependencies: { "@boringapi/cli": "1.0.0" }, devDependencies: { "@boringapi/cli": "2.0.0" } });
    write(root, "package.json", manifest);
    assert.throws(() => initializeProject(root), /Conflicting.*@boringapi\/cli/);
    assert.equal(readFileSync(join(root, "package.json"), "utf8"), manifest);
    assert.equal(existsSync(join(root, "api")), false);
    assert.equal(existsSync(join(root, ".boring")), false);
});

it("keeps Core and Zod only in runtime dependencies and rejects conflicting versions before writing", () => {
    for (const name of ["@boringapi/core", "zod"]) {
        for (const alreadyRuntime of [false, true]) {
            const root = fresh();
            const version = name === "zod" ? "3.25.76" : "file:../core";
            write(root, "package.json", JSON.stringify({
                dependencies: alreadyRuntime ? { [name]: version } : {},
                devDependencies: { [name]: version, lint: "1.0.0" },
            }));
            const result = initializeProject(root);
            const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
            assert.equal(manifest.dependencies[name], version);
            assert.equal(manifest.devDependencies[name], undefined);
            assert.equal(manifest.devDependencies.lint, "1.0.0");
            assert.ok(result.notes.some(note => note.includes(`Moved ${name} to dependencies`)));
        }
        const root = fresh();
        const manifest = JSON.stringify({ dependencies: { [name]: "1.0.0" }, devDependencies: { [name]: "2.0.0" } });
        write(root, "package.json", manifest);
        assert.throws(() => initializeProject(root), /Conflicting.*dependencies and devDependencies/);
        assert.equal(readFileSync(join(root, "package.json"), "utf8"), manifest);
        assert.equal(existsSync(join(root, "api")), false);
        assert.equal(existsSync(join(root, ".boring")), false);
    }
});

it("adds a minimal domain module and points back to existing modules without changing setup", () => {
    const root = fixture("app/http");
    const setup = readFileSync(join(root, "app/http/+setup.ts"), "utf8");
    const generated = addModule(root, "app/http", "order-items");
    assert.deepEqual(generated.files, ["app/modules/order-items/facade.ts", "app/modules/order-items/service.ts", "app/modules/order-items/schemas.ts"]);
    assert.match(readFileSync(join(root, generated.files[0]), "utf8"), /function createOrderItems/);
    assert.match(readFileSync(join(root, generated.files[1]), "utf8"), /Private business rules/);
    assert.equal(readFileSync(join(root, "app/http/+setup.ts"), "utf8"), setup);
    assert.match(generated.notes.join("\n"), /Import \$modules\/order-items\/facade in app\/http\/\+setup.ts/);
    assert.throws(() => addModule(root, "app/http", "health"), /already exists.*createHealth/);
    checked(root, "app/http");
});

it("reuses the order adapter, shared schemas, access rules and hooks without executing application code", () => {
    const root = fixture();
    orders(root);
    const original = readFileSync(join(root, "api/orders/[id]/get.ts"), "utf8");
    const facade = readFileSync(join(root, "modules/orders/facade.ts"), "utf8");
    const generated = addEndpoint(root, "api", "orders/lookup/[id]/get");
    assert.deepEqual(generated.files, ["api/orders/lookup/[id]/get.ts"]);
    assert.match(generated.notes.join("\n"), /Reused orders\/\[id\]\/get/);
    assert.equal(readFileSync(join(root, generated.files[0]), "utf8"), `${original}\n`);
    assert.equal(readFileSync(join(root, "modules/orders/facade.ts"), "utf8"), facade);
    const catalog = inspectProject(checked(root));
    const added = catalog.routes.find(route => route.path === "/orders/lookup/:id")!;
    const prior = catalog.routes.find(route => route.path === "/orders/:id")!;
    assert.equal(added.access.session, "required");
    assert.deepEqual(added.access.authorization?.kind === "literal" && added.access.authorization.value, "orders:read");
    assert.deepEqual(added.hooks, prior.hooks);
    assert.equal(added.input.params!.outputType, prior.input.params!.outputType);
    assert.equal(added.output!.outputType, prior.output!.outputType);
    assert.throws(() => addEndpoint(root, "api", "orders/[other]/get"), /conflicts/);
    assert.throws(() => addEndpoint(root, "api", "orders/archive/[id]/get"), /Multiple matching.*--from/);
    assert.equal(existsSync(join(root, "api/orders/archive")), false);
    addEndpoint(root, "api", "orders/archive/[id]/get", "orders/[id]/get");
    checked(root);
});

it("relocates relative schema imports and nested import types while retaining local generated types", () => {
    const root = fixture();
    orders(root);
    const original = readFileSync(join(root, "api/orders/[id]/get.ts"), "utf8").replace("$modules/orders/schemas", "../../../modules/orders/schemas");
    write(root, "api/orders/[id]/get.ts", `${original}\ntype Contract = import("../../../modules/orders/schemas").Order;\n`);
    addEndpoint(root, "api", "orders/lookup/[id]/get");
    const content = readFileSync(join(root, "api/orders/lookup/[id]/get.ts"), "utf8");
    assert.match(content, /from "\.\.\/\.\.\/\.\.\/\.\.\/modules\/orders\/schemas"/);
    assert.match(content, /import\("\.\.\/\.\.\/\.\.\/\.\.\/modules\/orders\/schemas"\)/);
    assert.match(content, /from "\.\/\$types"/);
    checked(root);
});

it("requires compatible explicit templates and creates a typed 501 adapter when none matches", () => {
    const root = fixture();
    write(root, "api/health/scoped/+middleware.ts", 'import type { MiddlewareContext } from "./$types"; export const handler = (_ctx: MiddlewareContext) => ({ marker: true });');
    assert.throws(() => addEndpoint(root, "api", "health/scoped/get", "health/get"), /same HTTP method, URL parameter names and inherited hooks/);
    assert.throws(() => addEndpoint(root, "api", "health/post", "health/get"), /same HTTP method/);
    assert.throws(() => addEndpoint(root, "api", "health/[id]/get", "health/get"), /URL parameter names/);
    assert.throws(() => addEndpoint(root, "api", "health/other/get", "missing/get"), /No endpoint template/);
    const result = addEndpoint(root, "api", "health/scoped/get");
    assert.match(result.notes.join("\n"), /typed 501 handler/);
    assert.match(readFileSync(join(root, result.files[0]), "utf8"), /HttpError\(501, "Not implemented"\)/);
    checked(root);
});

it("rolls back a new adapter if it invalidates an existing typed envelope", () => {
    const root = fixture();
    write(root, "web/client/api.ts", 'import type { ApiRoutes } from "$client"; export type Routes = ApiRoutes;');
    write(root, "api/+envelope.ts", 'import type { EnvelopeContext } from "./$types"; export const handler = (ctx: EnvelopeContext) => ctx.payload.status;');
    checked(root);
    const before = readFileSync(join(root, "api/+envelope.ts"), "utf8");
    const client = readFileSync(join(root, ".boring/types/api/$client.d.ts"), "utf8");
    assert.throws(() => addEndpoint(root, "api", "invoices/get"), /check diagnostics/);
    assert.equal(existsSync(join(root, "api/invoices")), false);
    assert.equal(readFileSync(join(root, "api/+envelope.ts"), "utf8"), before);
    assert.equal(readFileSync(join(root, ".boring/types/api/$client.d.ts"), "utf8"), client);
    checked(root);
});

it("rejects traversal, ambiguous casing, symlinks and invalid existing applications before writing source", () => {
    for (const api of ["../escape", "src/../../escape", "src/api;echo", "dist/api", "modules", "infra", "test"]) {
        const root = fresh();
        assert.throws(() => initializeProject(root, api));
        assert.equal(existsSync(join(root, "package.json")), false);
    }
    const root = fixture();
    for (const name of ["../escape", "orders/nested", "Orders", "orders.ts"]) assert.throws(() => addModule(root, "api", name), /lowercase module/);
    for (const name of ["../escape/get", "orders//get", "orders/get.ts", "orders/trace", "orders\\escape/get"]) assert.throws(() => addEndpoint(root, "api", name));
    assert.throws(() => addEndpoint(root, "api", "Health/other/get"), /differs only by case/);
    const outside = fresh();
    symlinkSync(outside, join(root, "api/linked"), "dir");
    assert.throws(() => addEndpoint(root, "api", "linked/get"), /symbolic links/);
    assert.equal(existsSync(join(outside, "get.ts")), false);
    rmSync(join(root, "api/linked"));
    write(root, "modules/invalid/facade.ts", 'import { handler } from "../../api/health/get"; export const invalid = handler;');
    assert.throws(() => addModule(root, "api", "invoices"), /BORING104/);
    assert.equal(existsSync(join(root, "modules/invoices")), false);
});
