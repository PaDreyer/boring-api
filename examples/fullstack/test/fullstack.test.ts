import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { it } from "node:test";
import { Pool } from "pg";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Actor } from "../modules/access/schemas";
import type { ExecutionContext } from "@boringapi/core";
import { BoringApi } from "@boringapi/core";
import { createClient, ApiError } from "@boringapi/core/client";
import { spawnSync } from "node:child_process";

const application = join(__dirname, "..");

async function execute<T>(identity: Actor, operation: (execution: ExecutionContext<Actor>) => Promise<T>): Promise<T> {
    const root = mkdtempSync(join(tmpdir(), "boring-order-execution-"));
    const app = await new BoringApi().createApp(root);
    try { return await app.execute({ identity }, ({ execution }) => operation(execution)); }
    finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
}


it("checks the fullstack application and prevents HTTP-free permission bypass through pages", async () => {
    const cli = join(require.resolve("@boringapi/cli/package.json"), "../bin/boring.cjs");
    const checked = spawnSync(process.execPath, [cli, "check"], { cwd: application, encoding: "utf8" });
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);
    const { createOrders } = await import("../modules/orders/facade");
    const { createPages } = await import("../web/server/pages");
    let calls = 0;
    const orders = createOrders({ async transaction() { calls++; throw new Error("Database must not be touched"); } });
    const pages = createPages(orders);
    const denied = { kind: "machine" as const, id: "denied", permissions: [] };
    await assert.rejects(execute(denied, ctx => orders.create(ctx, { item: "Book", quantity: 1 })), { code: "forbidden" });
    await assert.rejects(execute(denied, ctx => pages.order(ctx, randomUUID())), { code: "forbidden" });
    assert.equal(calls, 0);
});

it("runs order rules and audit writes through the transaction port", async () => {
    const { createOrders } = await import("../modules/orders/facade");
    const records = new Map<string, { id: string; item: string; quantity: number }>();
    const writes: string[] = [];
    let transactions = 0;
    const orders = createOrders({
        async transaction(_execution, operation) {
            transactions++;
            return operation({
                newId: randomUUID,
                async reserve() { return undefined; },
                async remember() {},
                async insert(value) { records.set(value.id, value); writes.push("order"); },
                async recordCreation(_value, actorId) { writes.push(`audit:${actorId}`); },
                async find(id) { return records.get(id); },
            });
        },
    });
    const actor = { kind: "user" as const, id: "operator", permissions: ["orders:create", "orders:read"] as const };
    const created = await execute(actor, ctx => orders.create(ctx, { item: "Notebook", quantity: 2 }));
    assert.deepEqual(writes, ["order", "audit:operator"]);
    assert.deepEqual(await execute(actor, ctx => orders.get(ctx, created.id)), created);
    await assert.rejects(execute(actor, ctx => orders.get(ctx, randomUUID())), { code: "not_found" });
    assert.equal(transactions, 3);
});

it("persists API and page results in PostgreSQL, rolls back failed business writes and validates migrations", {
    skip: !process.env.BORING_TEST_DATABASE_URL && "Set BORING_TEST_DATABASE_URL to run the real PostgreSQL integration test.",
}, async () => {
    const schema = `boring_test_${randomUUID().replace(/-/g, "")}`;
    const admin = new Pool({ connectionString: process.env.BORING_TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const connection = new URL(process.env.BORING_TEST_DATABASE_URL!);
    connection.searchParams.set("options", `-csearch_path=${schema}`);
    const url = connection.toString();
    const inspect = new Pool({ connectionString: url });
    const { createDatabase } = await import("../infra/db/database");
    const { createOrders } = await import("../modules/orders/facade");
    const { createPages } = await import("../web/server/pages");
    const database = createDatabase({ connectionString: url });
    const orders = createOrders(database.orders);
    const actor = { kind: "user" as const, id: "test-operator", permissions: ["orders:read", "orders:create"] as const };
    const beforeUrl = process.env.DATABASE_URL;
    const beforeToken = process.env.BORING_API_TOKEN;
    const token = randomUUID();
    process.env.DATABASE_URL = url;
    process.env.BORING_API_TOKEN = token;
    let server: import("node:http").Server | undefined;
    let owned: Awaited<ReturnType<BoringApi["createApp"]>> | undefined;
    try {
        await Promise.all([database.migrate(), database.migrate()]);
        assert.equal((await inspect.query("SELECT count(*)::int AS count FROM boring_migrations")).rows[0].count, 3);
        const created = await execute(actor, ctx => orders.create(ctx, { item: "<script>alert(1)</script>", quantity: 2 }));
        const restarted = createDatabase({ connectionString: url });
        try { assert.deepEqual(await execute(actor, ctx => createOrders(restarted.orders).get(ctx, created.id)), created); }
        finally { await restarted.close(); }
        const html = await execute(actor, ctx => createPages(orders).order(ctx, created.id));
        assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
        assert.doesNotMatch(html, /<script>/);
        await inspect.query("ALTER TABLE order_events ADD CONSTRAINT reject_test_actor CHECK (actor_id <> 'fail-audit')");
        const invalidActor = { ...actor, id: "fail-audit" };
        await assert.rejects(execute(invalidActor, ctx => orders.create(ctx, { item: "Must roll back", quantity: 1 })));
        assert.equal((await inspect.query("SELECT count(*)::int AS count FROM orders")).rows[0].count, 1);
        assert.equal((await inspect.query("SELECT count(*)::int AS count FROM order_events")).rows[0].count, 1);

        const app = owned = await new BoringApi().createApp(join(application, "api"));
        server = await new Promise<import("node:http").Server>((resolve, reject) => {
            const listening = app.http.listen(0, "127.0.0.1", () => resolve(listening));
            listening.once("error", reject);
        });
        const address = server.address() as import("node:net").AddressInfo;
        const base = `http://127.0.0.1:${address.port}`;
        type Routes = {
            "POST /orders": { input: { body: { item: string; quantity: number } }; output: typeof created };
            "GET /orders/:id": { input: { params: { id: string } }; output: typeof created };
            "GET /pages/orders/:id": { input: { params: { id: string } }; output: string };
        };
        const client = createClient<Routes>(base, { headers: () => ({ Authorization: `Bearer ${token}` }) });
        const viaHttp = await client.request("POST /orders", { body: { item: "From SPA", quantity: 3 } });
        assert.deepEqual(await client.request("GET /orders/:id", { params: { id: viaHttp.id } }), viaHttp);
        assert.match(await client.request("GET /pages/orders/:id", { params: { id: viaHttp.id } }), /From SPA/);
        const unauthenticated = createClient<Routes>(base);
        await assert.rejects(unauthenticated.request("GET /pages/orders/:id", { params: { id: viaHttp.id } }), error => error instanceof ApiError && error.status === 401);
        await assert.rejects(client.request("POST /orders", { body: { item: "", quantity: 0 } }), error => error instanceof ApiError && error.status === 400);
        await assert.rejects(client.request("GET /orders/:id", { params: { id: randomUUID() } }), error => error instanceof ApiError && error.status === 404);

        const saved = (await inspect.query("SELECT checksum FROM boring_migrations WHERE name = '001_orders'")).rows[0].checksum;
        await inspect.query("UPDATE boring_migrations SET checksum = 'changed' WHERE name = '001_orders'");
        await assert.rejects(database.migrate(), /Applied migration changed/);
        await inspect.query("UPDATE boring_migrations SET checksum = $1 WHERE name = '001_orders'", [saved]);
        await database.migrate();
    } finally {
        if (beforeUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = beforeUrl;
        if (beforeToken === undefined) delete process.env.BORING_API_TOKEN; else process.env.BORING_API_TOKEN = beforeToken;
        if (server) await new Promise<void>((resolve, reject) => { server!.close(error => error ? reject(error) : resolve()); server!.closeAllConnections(); });
        if (owned) await owned.close();
        await database.close();
        await inspect.end();
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin.end();
    }
});
