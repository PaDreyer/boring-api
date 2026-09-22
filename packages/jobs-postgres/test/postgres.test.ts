import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { Pool } from "pg";
import { ApplicationError, BoringApi, eventPublication } from "@boringapi/core";
import type { SetupContext, StoredJob } from "@boringapi/core";
import { createPostgresJobs, jobMigration, publicationMigration, stagePostgresEvent } from "../src";
const skip = !process.env.BORING_TEST_DATABASE_URL && "Set BORING_TEST_DATABASE_URL for actual PostgreSQL durability and crash tests";
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function database(run: (pool: Pool, url: string) => Promise<void>) {
    const admin = new Pool({ connectionString: process.env.BORING_TEST_DATABASE_URL });
    const schema = `jobs_${randomUUID().replace(/-/g, "")}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.BORING_TEST_DATABASE_URL!); url.searchParams.set("options", `-csearch_path=${schema}`);
    const pool = new Pool({ connectionString: url.toString() });
    try { await pool.query(jobMigration.sql); await pool.query(publicationMigration.sql); await run(pool, url.toString()); }
    finally { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
}
function job(overrides: Partial<StoredJob> = {}): StoredJob {
    return { id: randomUUID(), name: "orders/create", version: 1, payload: { value: "persisted" },
        origin: { identity: { kind: "user", id: "user" }, correlationId: "origin", tenantId: "tenant" },
        policy: { maxAttempts: 3, retryDelayMs: 10, timeoutMs: 5000 }, ...overrides };
}

it("rejects copied, forged and structurally inconsistent publication intents before SQL", async () => {
    const root = mkdtempSync(join(tmpdir(), "boring-publication-boundary-")); mkdirSync(join(root, "api"));
    const app = await new BoringApi().createApp(join(root, "api"));
    let queries = 0;
    const client = { async query() { queries++; return { rows: [{ id: "inserted" }], rowCount: 1 }; }, release() {} };
    try {
        const publication = await app.execute({ identity: { kind: "user", id: "origin", permissions: [] }, tenantId: "tenant", correlationId: "business" }, ({ execution }) =>
            eventPublication(execution, { id: randomUUID(), type: "orders.created", version: 1, payload: { orderId: randomUUID() } },
                { maxAttempts: 3, retryDelayMs: 10, timeoutMs: 1000 }));
        for (const invalid of [
            { ...publication },
            { ...publication, id: randomUUID() },
            { ...publication, origin: { ...publication.origin, identity: { ...publication.origin.identity, id: "forged" } } },
            { ...publication, payload: { event: { ...publication.payload.event, payload: { changed: true } } } },
        ]) await assert.rejects(stagePostgresEvent(client, invalid), { code: "invalid_publication" });
        assert.equal(queries, 0);
        assert.deepEqual(await stagePostgresEvent(client, publication), { id: publication.id });
        assert.equal(queries, 1);
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});

it("persists enqueue from an exited process and executes through a fresh compiler-free worker process", { skip }, async () => database(async (pool, url) => {
    const root = mkdtempSync(join(tmpdir(), "boring-pg-worker-"));
    const core = require.resolve("@boringapi/core"), adapter = require.resolve("../dist"), pg = require.resolve("pg");
    const input = job();
    try {
        const enqueue = spawnSync(process.execPath, ["-e", `
            const { Pool } = require(${JSON.stringify(pg)});
            const { createPostgresJobs } = require(${JSON.stringify(adapter)});
            const pool = new Pool({ connectionString: process.env.TEST_URL });
            (async () => { await createPostgresJobs(pool).enqueue(${JSON.stringify(input)}); await pool.end(); })().catch(e => { console.error(e); process.exitCode=1; });
        `], { env: { ...process.env, TEST_URL: url }, encoding: "utf8" });
        assert.equal(enqueue.status, 0, enqueue.stderr);
        assert.equal((await createPostgresJobs(pool).get(input.id))?.status, "pending");
        await pool.query("CREATE TABLE deliveries (id text PRIMARY KEY, actor text, tenant text, correlation text)");
        mkdirSync(join(root, "api")); mkdirSync(join(root, "jobs/orders/create"), { recursive: true });
        writeFileSync(join(root, "api/+setup.js"), `
            const { Pool } = require(${JSON.stringify(pg)});
            const { createPostgresJobs } = require(${JSON.stringify(adapter)});
            exports.setup = ctx => { const pool = new Pool({ connectionString: process.env.TEST_URL });
                ctx.onClose('pool', () => pool.end());
                ctx.jobs(createPostgresJobs(pool), { identity: {kind:'machine',id:'configured-worker',permissions:[]} });
                return { orders: { async create(ctx, id) { await pool.query('INSERT INTO deliveries VALUES ($1,$2,$3,$4)', [id,ctx.identity.id,ctx.tenantId,ctx.correlationId]); } } };
            };`);
        // The schema object is runtime-only fixture code; real declarations are checked separately.
        writeFileSync(join(root, "jobs/orders/create/job.js"), `
            exports.payload = { parseAsync: async value => value }; exports.version=1;
            exports.policy = {maxAttempts:3,retryDelayMs:10,timeoutMs:5000};
            exports.handler = async ctx => { await ctx.services.orders.create(ctx.execution, ctx.delivery.id); };
        `);
        const worker = spawnSync(process.execPath, ["-e", `
            const { BoringApi } = require(${JSON.stringify(core)});
            (async () => { const app = await new BoringApi().createApp(${JSON.stringify(join(root, "api"))});
                try { console.log(JSON.stringify(await app.runJob())); } finally { await app.close(); }
            })().catch(e => { console.error(e); process.exitCode=1; });
        `], { env: { ...process.env, TEST_URL: url }, encoding: "utf8" });
        assert.equal(worker.status, 0, worker.stderr); assert.match(worker.stdout, /succeeded/);
        const row = (await pool.query("SELECT * FROM deliveries")).rows[0];
        assert.equal(row.actor, "configured-worker"); assert.equal(row.tenant, "tenant"); assert.notEqual(row.correlation, "origin");
        assert.equal((await createPostgresJobs(pool).get(input.id))?.status, "succeeded");
    } finally { rmSync(root, { recursive: true, force: true }); }
}));

it("cooperates across concurrent workers, recovers a killed claimant and fences stale acknowledgements", { skip }, async () => database(async (pool, url) => {
    const queue = createPostgresJobs(pool);
    await queue.enqueue(job());
    const claims = await Promise.all(Array.from({ length: 6 }, () => queue.claim(5000)));
    assert.equal(claims.filter(Boolean).length, 1); await queue.succeed(claims.find(Boolean)!);
    const abandoned = job(); await queue.enqueue(abandoned);
    const child = spawn(process.execPath, ["-e", `
        const { Pool } = require(${JSON.stringify(require.resolve("pg"))});
        const { createPostgresJobs } = require(${JSON.stringify(require.resolve("../dist"))});
        const pool = new Pool({connectionString:process.env.TEST_URL});
        createPostgresJobs(pool).claim(200).then(claim => { console.log(JSON.stringify(claim)); setInterval(()=>{},1000); });
    `], { env: { ...process.env, TEST_URL: url }, stdio: ["ignore", "pipe", "pipe"] });
    const claimed: any = await new Promise((resolve, reject) => {
        let output = ""; const timeout = setTimeout(() => reject(new Error("claim child timed out")), 5000);
        child.stdout.on("data", chunk => { output += chunk; if (output.includes("\n")) { clearTimeout(timeout); resolve(JSON.parse(output.trim())); } });
        child.once("error", reject);
    });
    const dead = new Promise<void>(resolve => child.once("exit", () => resolve())); child.kill("SIGKILL"); await dead;
    assert.equal(claimed.id, abandoned.id); await delay(230);
    const recovered = await queue.claim(5000); assert.equal(recovered?.id, abandoned.id); assert.equal(recovered?.attempt, 2);
    assert.equal(await queue.succeed(claimed), false); assert.equal(await queue.renew(claimed, 5000), false);
    assert.equal(await queue.fail(claimed, { code: "stale", message: "old" }), false);
    assert.equal(await queue.succeed(recovered!), true);
}));

it("retains exhausted jobs, delays retries, renews leases and supports deliberate failed-job replay", { skip }, async () => database(async pool => {
    const queue = createPostgresJobs(pool), input = job({ policy: { maxAttempts: 2, retryDelayMs: 30, timeoutMs: 1000 } });
    await queue.enqueue(input); const first = (await queue.claim(1000))!;
    assert.equal(await queue.fail(first, { code: "transient", message: "retry me" }, 50), true);
    assert.equal(await queue.claim(1000), undefined); await delay(60);
    const second = (await queue.claim(80))!; assert.equal(second.attempt, 2);
    assert.equal(await queue.renew(second, 120), true); await delay(140);
    assert.equal(await queue.claim(1000), undefined);
    assert.equal((await queue.get(input.id))?.lastError?.code, "attempts_exhausted");
    assert.equal((await queue.failed()).length, 1);
    assert.equal(await queue.retry(input.id), true); assert.equal(await queue.retry(input.id), false);
    const replay = (await queue.claim(1000))!; assert.equal(replay.attempt, 1); assert.deepEqual(replay.payload, input.payload);
    assert.equal(await queue.fail(replay, { code: "forbidden", message: "Forbidden" }), true);
    assert.equal((await queue.get(input.id))?.status, "failed");
}));

it("stages event publications in the caller transaction, cooperates across publishers and prunes only successes", { skip }, async () => database(async pool => {
    const root = mkdtempSync(join(tmpdir(), "boring-publication-")); mkdirSync(join(root, "api"));
    const app = await new BoringApi().createApp(join(root, "api"));
    try {
        const publication = await app.execute({ identity: { kind: "user", id: "origin", permissions: [] }, tenantId: "tenant", correlationId: "business" }, ({ execution }) =>
            eventPublication(execution, { id: randomUUID(), type: "orders.created", version: 1, payload: { orderId: randomUUID() } },
                { maxAttempts: 3, retryDelayMs: 10, timeoutMs: 1000 }));
        const rollback = await pool.connect();
        try { await rollback.query("BEGIN"); await stagePostgresEvent(rollback, publication); await rollback.query("ROLLBACK"); }
        finally { rollback.release(); }
        assert.equal((await pool.query("SELECT count(*)::int n FROM boring_jobs")).rows[0].n, 0);

        const commit = await pool.connect();
        try {
            await commit.query("BEGIN"); await commit.query("SET LOCAL synchronous_commit=on");
            assert.deepEqual(await stagePostgresEvent(commit, publication), { id: publication.id });
            await commit.query("COMMIT");
        } finally { commit.release(); }
        const duplicate = await pool.connect();
        try { await duplicate.query("BEGIN"); assert.deepEqual(await stagePostgresEvent(duplicate, publication), { id: publication.id }); await duplicate.query("COMMIT"); }
        finally { duplicate.release(); }
        const conflicts = await app.execute({ identity: { kind: "user", id: "origin", permissions: [] }, tenantId: "tenant", correlationId: "retry" }, ({ execution }) => [
            eventPublication(execution, { ...publication.payload.event, payload: { changed: true } }, publication.policy),
            eventPublication(execution, { ...publication.payload.event, version: 2 }, publication.policy),
        ]);
        for (const conflict of conflicts) {
            const conflicting = await pool.connect();
            try {
                await conflicting.query("BEGIN"); await assert.rejects(stagePostgresEvent(conflicting, conflict), { code: "publication_conflict" }); await conflicting.query("ROLLBACK");
            } finally { conflicting.release(); }
        }

        const first = createPostgresJobs(pool), second = createPostgresJobs(pool);
        const claims = await Promise.all([first.claim(1000, "publication"), second.claim(1000, "publication")]);
        assert.equal(claims.filter(Boolean).length, 1);
        assert.equal(await first.prunePublications(Date.now() + 1000), 0);
        assert.equal(await first.succeed(claims.find(Boolean)!), true);
        assert.equal(await first.prunePublications(Date.now() + 1000), 1);
        assert.equal(await first.get(publication.id), undefined);
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
}));

it("checks lease expiry after acquiring a row lock for renew, succeed and fail", { skip }, async () => database(async pool => {
    const queue = createPostgresJobs(pool);
    for (const method of ["renew", "succeed", "fail"] as const) {
        const input = job(); await queue.enqueue(input);
        const claim = (await queue.claim(1000))!;
        const lock = await pool.connect(), writer = await pool.connect();
        const fenced = createPostgresJobs({ query: (text, values) => writer.query(text, values), connect: () => pool.connect() });
        let pending: Promise<boolean> | undefined;
        try {
            const pid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
            await lock.query("BEGIN");
            await lock.query("SELECT id FROM boring_jobs WHERE id = $1 FOR UPDATE", [claim.id]);
            pending = method === "renew" ? fenced.renew(claim, 1000) : method === "succeed" ? fenced.succeed(claim) :
                fenced.fail(claim, { code: "forbidden", message: "Forbidden" });
            // Verify the write really began before expiry and is waiting on our lock.
            let blocked = false;
            for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
                blocked = (await pool.query("SELECT wait_event_type = 'Lock' AS blocked FROM pg_stat_activity WHERE pid = $1", [pid])).rows[0]?.blocked;
                if (!blocked) await delay(5);
            }
            assert.equal(blocked, true, `${method} must wait on the held row lock`);
            assert.equal((await lock.query("SELECT lease_until > clock_timestamp() AS live FROM boring_jobs WHERE id = $1", [claim.id])).rows[0].live, true);
            await lock.query(`SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM lease_until - clock_timestamp())) + 0.02)
                FROM boring_jobs WHERE id = $1`, [claim.id]);
            await lock.query("COMMIT");
            assert.equal(await pending, false, `${method} must reject a lease that expired while waiting`);
            const record = (await queue.get(claim.id))!;
            assert.equal(record.status, "running"); assert.equal(record.lastError, null);
            const recovered = (await queue.claim(1000))!;
            assert.equal(recovered.id, claim.id); assert.notEqual(recovered.token, claim.token);
            assert.equal(await queue.succeed(recovered), true);
        } finally {
            await lock.query("ROLLBACK");
            if (pending) await Promise.allSettled([pending]);
            writer.release(); lock.release();
        }
    }
}));

it("retains terminal Unicode and NUL errors and continues processing subsequent jobs", { skip }, async () => database(async pool => {
    const queue = createPostgresJobs(pool), root = mkdtempSync(join(tmpdir(), "boring-pg-errors-"));
    const support = join(root, "support.cjs");
    let diagnostic: string | undefined;
    mkdirSync(join(root, "api")); mkdirSync(join(root, "jobs/orders/create"), { recursive: true });
    writeFileSync(support, "module.exports = {};");
    Object.assign(require(support), {
        setup(ctx: SetupContext) { ctx.jobs(queue, { identity: { kind: "machine", id: "worker", permissions: [] } }); return {}; },
        handler() {
            if (diagnostic !== undefined) throw new ApplicationError("forbidden", diagnostic);
        },
    });
    writeFileSync(join(root, "api/+setup.js"), `exports.setup = require(${JSON.stringify(support)}).setup;`);
    writeFileSync(join(root, "jobs/orders/create/job.js"), `
        exports.payload = { parseAsync: async value => value }; exports.version = 1;
        exports.policy = {maxAttempts:3,retryDelayMs:10,timeoutMs:5000};
        exports.handler = require(${JSON.stringify(support)}).handler;
    `);
    const app = await new BoringApi().createApp(join(root, "api"));
    try {
        const cases = [
            ["a".repeat(1999) + "😀", "a".repeat(1999)],
            ["a".repeat(1998) + "😀tail", "a".repeat(1998) + "😀"],
            ["Denied \u0000 input", "Denied \uFFFD input"],
            ["Invalid \uD800 and \uDC00; valid 😀", "Invalid \uFFFD and \uFFFD; valid 😀"],
        ];
        for (const [value, expected] of cases) {
            diagnostic = value;
            const input = job();
            // Persist valid input; the diagnostic originates in the handler, not JSONB payload storage.
            await queue.enqueue(input);
            assert.equal((await app.runJob())?.status, "failed");
            const record = (await queue.get(input.id))!;
            assert.equal(record.attempt, 1); assert.equal(record.status, "failed");
            assert.deepEqual(record.lastError, { code: "forbidden", message: expected });
        }
        diagnostic = undefined;
        const next = job(); await queue.enqueue(next);
        assert.equal((await app.runJob())?.status, "succeeded");
        assert.equal((await queue.get(next.id))?.status, "succeeded");
    } finally { await app.close(); delete require.cache[support]; rmSync(root, { recursive: true, force: true }); }
}));
