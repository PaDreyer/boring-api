import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { it } from "node:test";
import { Pool } from "pg";
import { BoringApi } from "@boringapi/core";
import type { Services } from "../api/$types";
import { createDatabase } from "../infra/db/database";
const skip = !process.env.BORING_TEST_DATABASE_URL && "Set BORING_TEST_DATABASE_URL for durable orders execution";

it("uses the same orders transaction and authorization for HTTP and durable jobs, including commit-before-ack redelivery", { skip }, async () => {
    const schema = `orders_jobs_${randomUUID().replace(/-/g, "")}`;
    const admin = new Pool({ connectionString: process.env.BORING_TEST_DATABASE_URL }); await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.BORING_TEST_DATABASE_URL!); url.searchParams.set("options", `-csearch_path=${schema}`);
    const db = createDatabase({ connectionString: url.toString() });
    const inspect = new Pool({ connectionString: url.toString() });
    const env = { DATABASE_URL: url.toString(), BORING_API_TOKEN: randomUUID() };
    const apps: Awaited<ReturnType<BoringApi["createApp"]>>[] = [];
    const start = async (permissions = "orders:create") => {
        const app = await new BoringApi().createApp<Services>(join(__dirname, "../api"), { env: { ...env, BORING_WORKER_PERMISSIONS: permissions } }); apps.push(app); return app;
    };
    const actor = { kind: "user" as const, id: "enqueuer", permissions: ["orders:create"] };
    try {
        await db.migrate();
        const http = await start(); const listener = await http.listen(0);
        const base = `http://127.0.0.1:${(listener.address() as import("node:net").AddressInfo).port}`;
        const input = { item: "one business effect", quantity: 2, requestId: randomUUID() };
        const headers = { authorization: `Bearer ${env.BORING_API_TOKEN}`, "content-type": "application/json" };
        const enqueued = await fetch(`${base}/orders/queued`, { method: "POST", headers, body: JSON.stringify(input) });
        assert.equal(enqueued.status, 202); const receipt = await enqueued.json() as { id: string };
        assert.equal((await db.jobs.get(receipt.id))?.status, "pending");
        await http.close();
        // Remove the acknowledgement: the business COMMIT succeeds but the process cannot confirm delivery.
        const module = require("../infra/db/database"), original = module.createDatabase;
        module.createDatabase = (config: any) => {
            const database = original(config); database.jobs.succeed = async () => false; return database;
        };
        const first = await start(); module.createDatabase = original;
        assert.equal((await first.runJob({ leaseMs: 300 }))?.status, "lost"); await first.close();
        assert.equal((await db.jobs.get(receipt.id))?.status, "running");
        assert.equal((await inspect.query("SELECT count(*)::int AS n FROM orders")).rows[0].n, 1);
        await inspect.query("UPDATE boring_jobs SET lease_until = clock_timestamp() - interval '1 second' WHERE id = $1", [receipt.id]);
        const restarted = await start(); assert.equal((await restarted.runJob())?.status, "succeeded");
        assert.equal((await db.jobs.get(receipt.id))?.attempt, 2);
        const same = await restarted.execute({ identity: actor }, ctx => ctx.services.orders.create(ctx.execution, input));
        const again = await restarted.execute({ identity: actor }, ctx => ctx.services.orders.enqueue(ctx.execution, input));
        assert.equal((await restarted.runJob())?.status, "succeeded");
        for (const table of ["orders", "order_events", "order_requests"]) assert.equal((await inspect.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 1);
        assert.equal((await db.jobs.get(again.id))?.status, "succeeded");
        await assert.rejects(restarted.execute({ identity: actor }, ctx => ctx.services.orders.create(ctx.execution, { ...input, quantity: 3 })), { code: "conflict" });
        await assert.rejects(restarted.execute({ identity: { ...actor, permissions: [] } }, ctx => ctx.services.orders.enqueue(ctx.execution, input)), { code: "forbidden" });
        // Current machine grants apply at delivery. Enqueuer grants are only provenance.
        const deniedJob = await restarted.execute({ identity: actor }, ctx => ctx.services.orders.enqueue(ctx.execution, { ...input, requestId: randomUUID() }));
        const denied = await start(""); assert.equal((await denied.runJob())?.status, "failed");
        assert.equal((await db.jobs.get(deniedJob.id))?.lastError?.code, "forbidden");
        assert.equal(await db.jobs.retry(deniedJob.id), true); assert.equal((await restarted.runJob())?.status, "succeeded");
        // UUID spellings share one database key and must also share its transaction lock.
        await inspect.query("CREATE FUNCTION slow_order() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.1); RETURN NEW; END $$");
        await inspect.query("CREATE TRIGGER slow_order BEFORE INSERT ON orders FOR EACH ROW EXECUTE FUNCTION slow_order()");
        const concurrentInput = { ...input, requestId: randomUUID() };
        const duplicates = await Promise.all([concurrentInput, { ...concurrentInput, requestId: concurrentInput.requestId.toUpperCase() }].map(value =>
            restarted.execute({ identity: actor }, ctx => ctx.services.orders.create(ctx.execution, value))));
        assert.deepEqual(duplicates[0], duplicates[1]);
        const reader = { ...actor, permissions: ["orders:read"] };
        assert.equal((await restarted.execute({ identity: reader }, ctx => ctx.services.orders.get(ctx.execution, same.id))).id, same.id);
    } finally {
        await Promise.all(apps.map(app => app.close())); await db.close(); await inspect.end();
        await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
    }
});
