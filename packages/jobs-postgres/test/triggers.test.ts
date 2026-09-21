import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { Pool } from "pg";
import { triggerId } from "@boringapi/core";
import type { AcceptedEvent, ScheduleRegistration, StoredJob } from "@boringapi/core";
import { createPostgresJobs, jobMigration, triggerMigration } from "../src";
const skip = !process.env.BORING_TEST_DATABASE_URL && "Set BORING_TEST_DATABASE_URL for actual trigger persistence";
const policy = { maxAttempts: 2, retryDelayMs: 1, timeoutMs: 1000 };
const origin = { identity: { kind: "machine" as const, id: "trusted-ingress" }, tenantId: "tenant", correlationId: "origin" };
async function database(run: (pool: Pool, url: string) => Promise<void>) {
    const admin = new Pool({ connectionString: process.env.BORING_TEST_DATABASE_URL });
    const schema = `triggers_${randomUUID().replace(/-/g, "")}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.BORING_TEST_DATABASE_URL!); url.searchParams.set("options", `-csearch_path=${schema}`);
    const pool = new Pool({ connectionString: url.toString() });
    try { await pool.query(jobMigration.sql); await pool.query(triggerMigration.sql); await run(pool, url.toString()); }
    finally { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
}
function registration(overrides: Partial<ScheduleRegistration> = {}): ScheduleRegistration {
    return { name: "orders/create", version: 1, timing: { startAt: Date.now() - 100000, everyMs: 1000, missed: "catch-up", maxCatchUp: 3, overlap: "allow" }, input: { value: "x" }, policy, origin, ...overrides };
}
function accepted() {
    const event: AcceptedEvent = { id: randomUUID(), type: "created", version: 1, payload: { value: "persisted" }, origin };
    const jobs: StoredJob[] = ["first", "second"].map(name => ({ id: triggerId("event", event.id, name), name: `@event/${name}`, version: 1, payload: { data: event.payload, metadata: { id: event.id, type: event.type, version: event.version } }, origin, policy }));
    return { event, jobs };
}
it("atomically fans out durable events, deduplicates concurrent ingress and preserves acceptance after restart", { skip }, async () => database(async (pool, url) => {
    const q = createPostgresJobs(pool), { event, jobs } = accepted();
    const receipts = await Promise.all(Array.from({ length: 8 }, () => q.acceptEvent(event, jobs)));
    assert.equal(new Set(receipts.map(r => JSON.stringify(r))).size, 1);
    assert.equal((await pool.query("SELECT count(*)::int n FROM boring_jobs")).rows[0].n, 2);
    assert.equal(await q.claim(1000), undefined, "ordinary workers must not claim event deliveries");
    await assert.rejects(q.acceptEvent({ ...event, payload: { value: "changed" } }, jobs), { code: "event_conflict" });
    await assert.rejects(q.acceptEvent({ ...event, version: 2 }, jobs), { code: "event_conflict" });
    await assert.rejects(q.acceptEvent({ ...event, origin: { ...origin, identity: { kind: "machine", id: "spoof" } } }, jobs), { code: "event_conflict" });
    const root = mkdtempSync(join(tmpdir(), "boring-event-process-"));
    try {
        mkdirSync(join(root, "api"));
        await pool.query("CREATE TABLE effects (consumer text PRIMARY KEY, event_id uuid, actor text, tenant text, correlation text)");
        writeFileSync(join(root, "api/+setup.js"), `const {Pool}=require(${JSON.stringify(require.resolve("pg"))});
            const {createPostgresJobs}=require(${JSON.stringify(require.resolve("../dist"))});
            exports.setup=ctx=>{const pool=new Pool({connectionString:process.env.TEST_URL});ctx.onClose('pg',()=>pool.end());
            ctx.events(createPostgresJobs(pool),{identity:{kind:'machine',id:'consumer',permissions:[]}});
            return { save: async (execution,event,name)=>{await pool.query('INSERT INTO effects VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[name,event.id,execution.identity.id,execution.tenantId,execution.correlationId]);} };};`);
        for (const name of ["first", "second"]) {
            mkdirSync(join(root, `events/${name}`), { recursive: true });
            writeFileSync(join(root, `events/${name}/event.js`), `const {z}=require(${JSON.stringify(require.resolve("zod", { paths: [require.resolve("@boringapi/core")] }))}); exports.payload=z.object({value:z.string()}); exports.event={type:'created',version:1}; exports.version=1; exports.policy=${JSON.stringify(policy)};
                exports.handler=ctx=>{if(ctx.payload.value==='fail'||ctx.payload.value==='retry'&&ctx.delivery.attempt===1)throw new Error('consumer failure');return ctx.services.save(ctx.execution,ctx.event,${JSON.stringify(name)});};`);
        }
        const run = () => spawnSync(process.execPath, ["-e", `const {BoringApi}=require(${JSON.stringify(require.resolve("@boringapi/core"))});(async()=>{const app=await new BoringApi().createApp(${JSON.stringify(join(root, "api"))});try{console.log(JSON.stringify(await app.runJob({kind:'event'})));}finally{await app.close();}})().catch(e=>{console.error(e);process.exitCode=1});`], { env: { ...process.env, TEST_URL: url }, encoding: "utf8", timeout: 10000 });
        for (let i = 0; i < 2; i++) { const child = run(); assert.equal(child.status, 0, child.stderr); assert.match(child.stdout, /succeeded/); }
        const effects = (await pool.query("SELECT * FROM effects ORDER BY consumer")).rows;
        assert.equal(effects.length, 2); assert.equal(effects[0].actor, "consumer"); assert.equal(effects[0].tenant, "tenant"); assert.notEqual(effects[0].correlation, origin.correlationId);
        assert.equal((await q.acceptEvent(event, jobs)).deliveries.length, 2);
        assert.equal((await pool.query("SELECT count(*)::int n FROM boring_jobs")).rows[0].n, 2);
        // Simulate lost confirmation after a committed effect, then deliver in a fresh process.
        await pool.query("UPDATE boring_jobs SET status='running', attempt=1, lease_token=gen_random_uuid(), lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [jobs[0].id]);
        const repeated = run(); assert.equal(repeated.status, 0, repeated.stderr); assert.match(repeated.stdout, /succeeded/);
        assert.equal((await pool.query("SELECT count(*)::int n FROM effects")).rows[0].n, 2);
        assert.equal((await q.get(jobs[0].id))?.attempt, 2);
        // Real handlers fail in one process and retry in another, preserving terminal errors.
        for (const value of ["retry", "fail"]) {
            const next = accepted();
            const nextEvent = { ...next.event, payload: { value } };
            const nextJob = { ...next.jobs[0], payload: { data: { value }, metadata: { id: next.event.id, type: next.event.type, version: next.event.version } } };
            await q.acceptEvent(nextEvent, [nextJob]);
            const failed = run(); assert.equal(failed.status, 0, failed.stderr); assert.match(failed.stdout, /retry/);
            const retried = run(); assert.equal(retried.status, 0, retried.stderr); assert.match(retried.stdout, value === "retry" ? /succeeded/ : /failed/);
            const stored = (await q.get(next.jobs[0].id))!; assert.equal(stored.attempt, 2);
            assert.equal(stored.status, value === "retry" ? "succeeded" : "failed");
            if (value === "fail") assert.equal(stored.lastError?.message, "consumer failure");
        }
    } finally { rmSync(root, { recursive: true, force: true }); }
}));
it("rolls back event acceptance if any consumer handoff fails", { skip }, async () => database(async pool => {
    const q = createPostgresJobs(pool), { event, jobs } = accepted();
    await assert.rejects(q.acceptEvent(event, [jobs[0], { ...jobs[1], id: jobs[0].id }]));
    for (const table of ["boring_events", "boring_jobs"]) assert.equal((await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 0);
    assert.equal((await q.acceptEvent(event, jobs)).deliveries.length, 2);
}));
it("serializes concurrent schedulers, bounds catch-up, survives scheduler restart and skips outstanding work", { skip }, async () => database(async (pool, url) => {
    const q = createPostgresJobs(pool), declaration = registration({ timing: { startAt: Date.now() - 1000000, everyMs: 100000, missed: "catch-up", maxCatchUp: 3, overlap: "allow" } });
    const all = await Promise.all(Array.from({ length: 10 }, () => q.schedule(declaration)));
    assert.equal(all.flat().length, 3); assert.equal(new Set(all.flat().map(o => o.id)).size, 3);
    const child = spawnSync(process.execPath, ["-e", `const {Pool}=require(${JSON.stringify(require.resolve("pg"))});const {createPostgresJobs}=require(${JSON.stringify(require.resolve("../dist"))});const p=new Pool({connectionString:process.env.TEST_URL});(async()=>{console.log(JSON.stringify(await createPostgresJobs(p).schedule(${JSON.stringify(declaration)})));await p.end();})().catch(e=>{console.error(e);process.exitCode=1});`], { env: { ...process.env, TEST_URL: url }, encoding: "utf8", timeout: 10000 });
    assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout.trim(), "[]");
    assert.equal(await q.claim(1000), undefined); assert.equal(await q.claim(1000, "event"), undefined);
    const first = (await q.claim(1000, "schedule"))!;
    assert.equal(await q.fail(first, { code: "retry", message: "again" }, 0), true);
    const retry = (await q.claim(1000, "schedule"))!;
    // Other occurrences may run first: no ordering is promised, but each ID remains stable.
    assert.ok(all.flat().some(o => o.id === retry.id));
    await q.succeed(retry);
    const skipRegistration = registration({ name: "skip", timing: { ...declaration.timing, overlap: "skip" } });
    const admitted = await q.schedule(skipRegistration); assert.equal(admitted.length, 1);
    await pool.query("UPDATE boring_schedule_cursors SET scheduled_at=scheduled_at-100000 WHERE name='skip'");
    assert.equal((await q.schedule(skipRegistration)).length, 0);
    assert.equal((await pool.query("SELECT count(*)::int n FROM boring_jobs WHERE name='@schedule/skip'")).rows[0].n, 1);
    await pool.query("UPDATE boring_jobs SET status='succeeded' WHERE name='@schedule/skip'");
    await pool.query("UPDATE boring_schedule_cursors SET scheduled_at=scheduled_at-100000 WHERE name='skip'");
    // Rewinding is unsupported operator corruption; duplicate occurrence cannot become new work.
    await assert.rejects(q.schedule(skipRegistration), /duplicate key/);
}));
it("rolls back cursor advancement on failed handoff, and rejects same-version changes and old schedulers", { skip }, async () => database(async pool => {
    const q = createPostgresJobs(pool), declaration = registration();
    await pool.query("CREATE FUNCTION reject_schedule() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'handoff unavailable'; END $$");
    await pool.query("CREATE TRIGGER reject_schedule BEFORE INSERT ON boring_jobs FOR EACH ROW EXECUTE FUNCTION reject_schedule()");
    await assert.rejects(q.schedule(declaration), /handoff unavailable/);
    assert.equal((await pool.query("SELECT count(*)::int n FROM boring_schedule_cursors")).rows[0].n, 0);
    await pool.query("DROP TRIGGER reject_schedule ON boring_jobs");
    assert.equal((await q.schedule(declaration)).length, 3);
    await assert.rejects(q.schedule({ ...declaration, input: { value: "changed" } }), { code: "schedule_changed" });
    assert.equal((await q.schedule({ ...declaration, version: 2, input: { value: "changed" } })).length, 3);
    await assert.rejects(q.schedule(declaration), { code: "schedule_changed" });
}));
it("retains exhausted event deliveries through the same fenced retry protocol", { skip }, async () => database(async pool => {
    const q = createPostgresJobs(pool), { event, jobs } = accepted(); await q.acceptEvent(event, [jobs[0]]);
    const first = (await q.claim(1000, "event"))!; assert.equal(await q.fail(first, { code: "transient", message: "retry" }, 0), true);
    const second = (await q.claim(1000, "event"))!; assert.equal(second.id, first.id); assert.equal(second.attempt, 2);
    assert.equal(await q.fail(second, { code: "exhausted", message: "retained" }, 0), true);
    assert.equal(await q.claim(1000, "event"), undefined); assert.equal((await q.get(first.id))?.status, "failed");
    assert.equal((await q.failed())[0].lastError?.message, "retained");
}));
