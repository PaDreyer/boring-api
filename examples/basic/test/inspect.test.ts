import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { it } from "node:test";

const application = join(__dirname, "..");
function inspect(...args: string[]): string {
    const cli = join(require.resolve("@boringapi/cli/package.json"), "../bin/boring.cjs");
    const result = spawnSync(process.execPath, [cli, "inspect", ...args], {
        cwd: application, encoding: "utf8", maxBuffer: 2 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
}

it("locates existing order operations, schemas, permissions and inherited example hooks", () => {
    const result = JSON.parse(inspect("--json"));
    assert.equal(result.schemaVersion, 6);
    const orders = result.services.find((service: { name: string }) => service.name === "orders")!;
    assert.deepEqual(orders.operations.map((operation: { access: string }) => operation.access), ["ctx.services.orders.create", "ctx.services.orders.get"]);
    assert.ok(orders.operations.every((operation: { source: { file: string } }) => operation.source.file === "modules/orders/facade.ts"));
    const route = result.routes.find((route: { path: string; method: string }) => route.path === "/orders" && route.method === "POST")!;
    assert.equal(route.access.session, "required");
    assert.equal(route.access.authorization?.kind, "literal");
    assert.match(JSON.stringify(route.access.authorization), /orders:create/);
    assert.match(route.input.body!.outputType, /quantity: number/);
    assert.equal(route.hooks.errors.statuses["404"]!.file, "api/orders/+error.404.ts");
    assert.equal(result.routes.find((route: { path: string; method: string }) => route.path === "/health")!.hooks.envelope.enabled, false);
    assert.deepEqual(result.routes.find((route: { path: string; method: string }) => route.path === "/items/:id")!.hooks.middleware.map((source: { file: string }) => source.file),
        ["api/+middleware.ts", "api/items/+middleware.ts"]);
    const readable = inspect();
    assert.match(readable, /POST \/orders/);
    assert.match(readable, /ctx.services.orders.get/);
    assert.match(readable, /authorization: "orders:create"/);
    assert.ok(!JSON.stringify(result).includes(application));
});
