import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { Pool } from "pg";
import { BoringApi } from "@boringapi/core";
import type { Services } from "../api/$types";
import { createDatabase } from "../infra/db/database";

const skip = !process.env.BORING_TEST_DATABASE_URL && "Set BORING_TEST_DATABASE_URL for transactional publication tests";
const application = resolve(__dirname, "..");

it("publishes a business-transaction outbox after crashes, fences competing publishers and deduplicates lost confirmation", { skip }, async () => {
    const schema = `orders_publications_${randomUUID().replace(/-/g, "")}`;
    const admin = new Pool({ connectionString: process.env.BORING_TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const connection = new URL(process.env.BORING_TEST_DATABASE_URL!);
    connection.searchParams.set("options", `-csearch_path=${schema}`);
    const url = connection.toString();
    const database = createDatabase({ connectionString: url });
    const sql = new Pool({ connectionString: url });
    const apps: Awaited<ReturnType<BoringApi["createApp"]>>[] = [];
    const env = { DATABASE_URL: url, BORING_EVENT_PERMISSIONS: "orders:create,orders:observe", BORING_PUBLISHER_PERMISSIONS: "" };
    const start = async () => {
        const app = await new BoringApi().createApp<Services>(join(application, "api"), { env });
        apps.push(app);
        return app;
    };
    const createInCrashedProcess = (input: { item: string; quantity: number; requestId: string }, tenant: string, correlation: string) => {
        const child = spawnSync(process.execPath, ["-r", "ts-node/register", "-r", join(application, "test/register.ts"), "-e", `
            const {join}=require('node:path'); const {BoringApi}=require('@boringapi/core');
            (async()=>{const app=await new BoringApi().createApp(join(process.cwd(),'api'),{env:process.env});
            await app.execute({identity:{kind:'user',id:'publisher-origin',permissions:['orders:create']},tenantId:process.env.TEST_TENANT,correlationId:process.env.TEST_CORRELATION},
                ctx=>ctx.services.orders.create(ctx.execution,JSON.parse(process.env.TEST_INPUT))); process.exit(0);})().catch(error=>{console.error(error);process.exit(1)});
        `], { cwd: application, env: { ...process.env, ...env, TEST_INPUT: JSON.stringify(input), TEST_TENANT: tenant, TEST_CORRELATION: correlation }, encoding: "utf8", timeout: 10000 });
        assert.equal(child.status, 0, child.stderr);
    };
    try {
        await database.migrate();
        const firstInput = { item: "survives publisher downtime", quantity: 1, requestId: randomUUID() };
        createInCrashedProcess(firstInput, "tenant-a", "business-origin-a");
        const firstPublication = (await sql.query("SELECT id, status, origin FROM boring_jobs WHERE name='@publication/event'")).rows[0];
        assert.equal(firstPublication.status, "pending");
        assert.deepEqual(firstPublication.origin, { identity: { kind: "user", id: "publisher-origin" }, tenantId: "tenant-a", correlationId: "business-origin-a" });

        const publisherA = await start(), publisherB = await start();
        const attempts = await Promise.all([publisherA.runJob({ kind: "publication", leaseMs: 500 }), publisherB.runJob({ kind: "publication", leaseMs: 500 })]);
        assert.equal(attempts.filter(Boolean).length, 1);
        assert.equal(attempts.find(Boolean)?.status, "succeeded");
        assert.equal((await publisherA.runJob({ kind: "event" }))?.status, "succeeded");
        assert.equal((await sql.query("SELECT count(*)::int n FROM order_created_projections")).rows[0].n, 1);

        const secondInput = { item: "lost publisher confirmation", quantity: 2, requestId: randomUUID() };
        createInCrashedProcess(secondInput, "tenant-b", "business-origin-b");
        const crash = spawnSync(process.execPath, ["-r", "ts-node/register", "-r", join(application, "test/register.ts"), "-e", `
            const {join}=require('node:path'); const database=require('./infra/db/database'); const original=database.createDatabase;
            database.createDatabase=config=>{const value=original(config);const succeed=value.jobs.succeed.bind(value.jobs);
                value.jobs.succeed=claim=>claim.name==='@publication/event'?process.exit(17):succeed(claim);return value;};
            const {BoringApi}=require('@boringapi/core');(async()=>{const app=await new BoringApi().createApp(join(process.cwd(),'api'),{env:process.env});
                await app.runJob({kind:'publication',leaseMs:100});})().catch(error=>{console.error(error);process.exit(1)});
        `], { cwd: application, env: { ...process.env, ...env }, encoding: "utf8", timeout: 10000 });
        assert.equal(crash.status, 17, crash.stderr);
        assert.equal((await sql.query("SELECT count(*)::int n FROM boring_events WHERE type='orders.created'")).rows[0].n, 2);
        assert.equal((await publisherB.runJob({ kind: "event" }))?.status, "succeeded");
        assert.equal((await sql.query("SELECT count(*)::int n FROM order_created_projections")).rows[0].n, 2);

        await sql.query("UPDATE boring_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE name='@publication/event' AND status='running'");
        const restarted = await start();
        assert.equal((await restarted.runJob({ kind: "publication" }))?.status, "succeeded");
        assert.equal(await restarted.runJob({ kind: "event" }), undefined);
        assert.equal((await sql.query("SELECT count(*)::int n FROM boring_events WHERE type='orders.created'")).rows[0].n, 2);

        await sql.query("CREATE FUNCTION reject_publication() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'outbox unavailable'; END $$");
        await sql.query("CREATE TRIGGER reject_publication BEFORE INSERT ON boring_jobs FOR EACH ROW WHEN (NEW.name='@publication/event') EXECUTE FUNCTION reject_publication()");
        const before = (await sql.query("SELECT count(*)::int n FROM orders")).rows[0].n;
        await assert.rejects(restarted.execute({ identity: { kind: "user", id: "rollback", permissions: ["orders:create"] } }, ctx =>
            ctx.services.orders.create(ctx.execution, { item: "must roll back", quantity: 1, requestId: randomUUID() })), /outbox unavailable/);
        assert.equal((await sql.query("SELECT count(*)::int n FROM orders")).rows[0].n, before);
        await sql.query("DROP TRIGGER reject_publication ON boring_jobs");

        assert.equal(await database.jobs.prunePublications(Date.now() + 1000, 100), 2);
        assert.equal((await sql.query("SELECT count(*)::int n FROM boring_jobs WHERE name='@publication/event'")).rows[0].n, 0);
    } finally {
        await Promise.all(apps.map(app => app.close()));
        await database.close(); await sql.end();
        await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
    }
});
