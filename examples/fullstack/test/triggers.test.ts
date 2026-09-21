import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { it } from "node:test";
import { Pool } from "pg";
import { BoringApi } from "@boringapi/core";
import type { Services } from "../api/$types";
import { createDatabase } from "../infra/db/database";
const skip = !process.env.BORING_TEST_DATABASE_URL && "Set BORING_TEST_DATABASE_URL for the shared trigger use case";
it("preserves the same order/audit/idempotency transaction across HTTP, job, event, schedule and command", { skip }, async () => {
    const schema = `orders_triggers_${randomUUID().replace(/-/g, "")}`;
    const admin = new Pool({ connectionString: process.env.BORING_TEST_DATABASE_URL }); await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.BORING_TEST_DATABASE_URL!); url.searchParams.set("options", `-csearch_path=${schema}`);
    const db = createDatabase({ connectionString: url.toString() }), sql = new Pool({ connectionString: url.toString() });
    const env = { DATABASE_URL: url.toString(), BORING_API_TOKEN: randomUUID(), BORING_COMMAND_PERMISSIONS: "orders:create", BORING_EVENT_PERMISSIONS: "orders:create", BORING_SCHEDULE_PERMISSIONS: "orders:create" };
    const apps: Awaited<ReturnType<BoringApi["createApp"]>>[] = [];
    const start = async (permissions = "orders:create") => { const app = await new BoringApi().createApp<Services>(join(__dirname, "../api"), { env: { ...env, BORING_COMMAND_PERMISSIONS: permissions, BORING_EVENT_PERMISSIONS: permissions, BORING_SCHEDULE_PERMISSIONS: permissions } }); apps.push(app); return app; };
    try {
        await db.migrate(); const app = await start(); const listener = await app.listen(0);
        const base = `http://127.0.0.1:${(listener.address() as import("node:net").AddressInfo).port}`;
        const input = { item: "shared effect", quantity: 2, requestId: randomUUID() };
        const response = await fetch(`${base}/orders`, { method: "POST", headers: { authorization: `Bearer ${env.BORING_API_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(input) });
        assert.equal(response.status, 201); const order = await response.json();
        assert.deepEqual(await app.command("orders/create", input), order);
        const trusted = { identity: { kind: "machine" as const, id: "ingress", permissions: ["orders:create"] }, correlationId: "event-origin" };
        await app.execute(trusted, ctx => ctx.services.orders.enqueue(ctx.execution, input)); assert.equal((await app.runJob())?.status, "succeeded");
        const event = { id: randomUUID(), type: "orders.create-requested", version: 1, payload: input };
        const receipt = await app.acceptEvent(trusted, event); assert.equal((await app.runJob({ kind: "event" }))?.status, "succeeded");
        assert.deepEqual(await app.acceptEvent(trusted, event), receipt);
        for (const table of ["orders", "order_events", "order_requests"]) assert.equal((await sql.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 1);
        // Business commit was successful, but event confirmation was lost: fresh owner repeats safely.
        await sql.query("UPDATE boring_jobs SET status='running', attempt=1, lease_token=gen_random_uuid(), lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [receipt.deliveries[0]]);
        const restarted = await start(); assert.equal((await restarted.runJob({ kind: "event" }))?.status, "succeeded");
        for (const table of ["orders", "order_events", "order_requests"]) assert.equal((await sql.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 1);
        const occurrences = await app.tick(); assert.equal(occurrences.length, 1); assert.equal((await app.runJob({ kind: "schedule" }))?.status, "succeeded");
        assert.equal((await sql.query("SELECT count(*)::int n FROM orders")).rows[0].n, 2);
        assert.equal((await sql.query("SELECT count(*)::int n FROM order_requests WHERE request_id=$1", [occurrences[0].id])).rows[0].n, 1);
        await sql.query("UPDATE boring_jobs SET status='running', attempt=1, lease_token=gen_random_uuid(), lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [occurrences[0].id]);
        assert.equal((await restarted.runJob({ kind: "schedule" }))?.status, "succeeded");
        assert.equal((await sql.query("SELECT count(*)::int n FROM orders")).rows[0].n, 2);
        const denied = await start(""); await assert.rejects(denied.command("orders/create", { ...input, requestId: randomUUID() }), { code: "forbidden" });
        const deniedReceipt = await app.acceptEvent(trusted, { ...event, id: randomUUID(), payload: { ...input, requestId: randomUUID() } });
        assert.equal((await denied.runJob({ kind: "event" }))?.status, "failed"); assert.equal((await db.jobs.get(deniedReceipt.deliveries[0]))?.lastError?.code, "forbidden");
        await sql.query("UPDATE boring_jobs SET status='running', lease_token=gen_random_uuid(), lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [occurrences[0].id]);
        assert.equal((await denied.runJob({ kind: "schedule" }))?.status, "failed");
        assert.equal((await db.jobs.get(occurrences[0].id))?.lastError?.code, "forbidden");
        assert.equal((await sql.query("SELECT count(*)::int n FROM orders")).rows[0].n, 2);
    } finally { await Promise.all(apps.map(app => app.close())); await db.close(); await sql.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
});
