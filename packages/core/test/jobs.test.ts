import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { z } from "zod";
import { BoringApi, ApplicationError, JobAdapter, JobClaim, JobContext, JobDeclaration, JobPort, StoredJob, ShutdownTimeoutError } from "../src";
import { jobJson } from "../src/core/jobs";
import type { SetupContext } from "../src";
const machine = { kind: "machine" as const, id: "worker", permissions: ["orders:create"] };
const user = { kind: "user" as const, id: "caller", permissions: ["orders:create"] };
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function queue() {
    const jobs: StoredJob[] = [];
    const attempts = new Map<string, number>();
    const outcomes: { state: string; code?: string; retry?: number }[] = [];
    let renewals = 0;
    const adapter: JobAdapter = {
        async enqueue(job) { jobs.push(JSON.parse(JSON.stringify(job))); },
        async claim() { const job = jobs.shift(); if (!job) return; const attempt = (attempts.get(job.id) ?? 0) + 1; attempts.set(job.id, attempt); return { ...job, attempt, token: String(attempt) }; },
        async renew() { renewals++; return true; },
        async succeed() { outcomes.push({ state: "succeeded" }); return true; },
        async fail(claim, error, retry) { outcomes.push({ state: "failed", code: error.code, retry }); if (retry !== undefined) jobs.push(claim); return true; },
    };
    return { jobs, outcomes, adapter, get renewals() { return renewals; } };
}
function fixture(adapter: JobAdapter, handler: JobDeclaration["handler"], options: { payload?: z.ZodTypeAny; cleanup?: () => void; identity?: typeof machine } = {}) {
    const root = mkdtempSync(join(tmpdir(), "boring-jobs-"));
    mkdirSync(join(root, "api")); mkdirSync(join(root, "jobs/test"), { recursive: true });
    const support = join(root, "support.cjs"); writeFileSync(support, "module.exports = {};");
    let port!: JobPort<any>;
    Object.assign(require(support), { payload: options.payload ?? z.object({ value: z.string() }).strict(), version: 1,
        policy: { maxAttempts: 3, retryDelayMs: 10, timeoutMs: 5000 }, handler,
        setup(ctx: SetupContext<any, { test: any }>) { port = ctx.jobs(adapter, { identity: options.identity ?? machine }).for("test"); ctx.onClose("test", () => options.cleanup?.()); return {}; } });
    writeFileSync(join(root, "api/+setup.js"), `exports.setup = require(${JSON.stringify(support)}).setup;`);
    writeFileSync(join(root, "jobs/test/job.js"), `const s = require(${JSON.stringify(support)}); for (const k of ['payload','version','policy','handler']) exports[k] = s[k];`);
    return { api: join(root, "api"), get port() { return port; }, cleanup() { rmSync(root, { recursive: true, force: true }); delete require.cache[support]; } };
}

it("validates JSON at enqueue and execution and persists only inert origin data", async () => {
    const q = queue(); const calls: string[] = [];
    const source = fixture(q.adapter, ctx => { calls.push(ctx.payload.value); }, { payload: z.object({ value: z.string().transform(value => `${value}!`) }) });
    const app = await new BoringApi().createApp(source.api);
    try {
        const receipt = await app.execute({ identity: user, tenantId: "tenant-a", correlationId: "original" }, ctx => source.port.enqueue(ctx.execution, { value: "input" }));
        assert.equal(q.jobs[0].id, receipt.id); assert.deepEqual(q.jobs[0].payload, { value: "input" });
        assert.deepEqual(q.jobs[0].origin, { identity: { kind: "user", id: "caller" }, tenantId: "tenant-a", correlationId: "original" });
        assert.equal((await app.runJob())?.status, "succeeded"); assert.deepEqual(calls, ["input!"]);
        for (const value of [undefined, NaN, Infinity, new Date(), { value: undefined }, [,,], { get value() { throw new Error("getter ran"); } }, { signal: new AbortController().signal }]) {
            assert.throws(() => jobJson(value), /Job/);
        }
        const cyclic: any = {}; cyclic.self = cyclic; assert.throws(() => jobJson(cyclic), /Job/);
        await assert.rejects(app.execute({ identity: user }, ctx => source.port.enqueue(ctx.execution, { value: 1 })), { code: "invalid_payload" });
        await assert.rejects(source.port.enqueue({ identity: user, throwIfAborted() {} } as any, { value: "fake" }), /framework-created/);
    } finally { await app.close(); source.cleanup(); }
});

it("retries unexpected failures with bounded exponential delay and retains terminal failures", async () => {
    const q = queue(); const source = fixture(q.adapter, () => { throw new Error("transient"); });
    const app = await new BoringApi().createApp(source.api);
    try {
        await app.execute({ identity: user }, ctx => source.port.enqueue(ctx.execution, { value: "x" }));
        assert.equal((await app.runJob())?.status, "retry"); assert.equal((await app.runJob())?.status, "retry");
        assert.equal((await app.runJob())?.status, "failed");
        assert.deepEqual(q.outcomes.map(item => item.retry), [10, 20, undefined]);
    } finally { await app.close(); source.cleanup(); }
});

it("bounds failure messages without splitting Unicode pairs before passing them to the adapter", async () => {
    const q = queue(); const messages: string[] = [];
    const fail = q.adapter.fail;
    q.adapter.fail = async (claim, error, retry) => { messages.push(error.message); return fail(claim, error, retry); };
    const source = fixture(q.adapter, ctx => { throw new ApplicationError("forbidden", ctx.payload.value); });
    const app = await new BoringApi().createApp(source.api);
    try {
        for (const value of ["a".repeat(1999) + "😀", "a".repeat(1998) + "😀tail", "😀".repeat(1001)]) {
            await app.execute({ identity: user }, ctx => source.port.enqueue(ctx.execution, { value }));
            assert.equal((await app.runJob())?.status, "failed");
        }
        assert.deepEqual(messages, ["a".repeat(1999), "a".repeat(1998) + "😀", "😀".repeat(1000)]);
    } finally { await app.close(); source.cleanup(); }
});

it("fails unknown declarations, incompatible versions, invalid stored payloads and denied business access without retry", async () => {
    const q = queue(); let called = 0;
    const source = fixture(q.adapter, () => { called++; throw new ApplicationError("forbidden", "Forbidden"); });
    const app = await new BoringApi().createApp(source.api);
    try {
        for (const change of [{ name: "removed" }, { version: 2 }, { payload: { value: 1 } }, {}]) {
            await app.execute({ identity: user }, ctx => source.port.enqueue(ctx.execution, { value: "x" }));
            Object.assign(q.jobs[0], change); assert.equal((await app.runJob())?.status, "failed");
        }
        assert.deepEqual(q.outcomes.map(item => item.code), ["unknown_job", "incompatible_version", "invalid_payload", "forbidden"]);
        assert.equal(called, 1);
    } finally { await app.close(); source.cleanup(); }
});

it("creates fresh contexts, machine grants and attempt correlations while retaining original tenant/correlation", async () => {
    const q = queue(); const contexts: JobContext<any, any>[] = [];
    const source = fixture(q.adapter, ctx => { contexts.push(ctx); if (contexts.length === 1) throw new Error("retry"); });
    const app = await new BoringApi().createApp(source.api);
    try {
        await app.execute({ identity: user, tenantId: "a", correlationId: "origin-a" }, ctx => source.port.enqueue(ctx.execution, { value: "a" }));
        await app.runJob(); await app.runJob();
        await app.execute({ identity: user, tenantId: "b", correlationId: "origin-b" }, ctx => source.port.enqueue(ctx.execution, { value: "b" })); await app.runJob();
        assert.equal(new Set(contexts.map(ctx => ctx.execution)).size, 3);
        assert.equal(new Set(contexts.map(ctx => ctx.execution.correlationId)).size, 3);
        assert.deepEqual(contexts.map(ctx => ctx.execution.tenantId), ["a", "a", "b"]);
        assert.deepEqual(contexts.map(ctx => ctx.delivery.origin.correlationId), ["origin-a", "origin-a", "origin-b"]);
        assert.deepEqual(contexts.map(ctx => ctx.delivery.attempt), [1, 2, 1]);
        for (const ctx of contexts) { assert.deepEqual(ctx.execution.identity, machine); assert.equal(ctx.execution.signal.aborted, true); }
    } finally { await app.close(); source.cleanup(); }
});

it("keeps renewing and owns resources through non-cooperative work after shutdown timeout", async () => {
    const q = queue(), entered = deferred(), release = deferred(); let disposed = false;
    const source = fixture(q.adapter, async () => { entered.resolve(); await release.promise; }, { cleanup() { disposed = true; } });
    const app = await new BoringApi().createApp(source.api, { shutdownGraceMs: 5, shutdownTimeoutMs: 20 });
    try {
        await app.execute({ identity: user }, ctx => source.port.enqueue(ctx.execution, { value: "x" }));
        const work = app.runJob({ leaseMs: 60 }); await entered.promise;
        const closing = app.close(); assert.equal(app.close(), closing); await assert.rejects(closing, ShutdownTimeoutError);
        await delay(65); assert.equal(disposed, false); assert.ok(q.renewals >= 2); assert.equal(q.outcomes.length, 0);
        release.resolve(); assert.equal((await work)?.status, "retry"); await app.closed; assert.equal(disposed, true);
        await assert.rejects(app.runJob(), { code: "unavailable" });
    } finally { release.resolve(); await app.closed; source.cleanup(); }
});

it("loses a lease without acknowledgement or resource disposal under the unsettled operation", async () => {
    const q = queue(), entered = deferred(), release = deferred(); let signal!: AbortSignal;
    q.adapter.renew = async () => false;
    const source = fixture(q.adapter, async ctx => { signal = ctx.execution.signal; entered.resolve(); await release.promise; });
    const app = await new BoringApi().createApp(source.api);
    try {
        await app.execute({ identity: user }, ctx => source.port.enqueue(ctx.execution, { value: "x" }));
        const work = app.runJob({ leaseMs: 30 }); await entered.promise; await delay(35);
        assert.equal(signal.aborted, true); assert.equal(q.outcomes.length, 0);
        release.resolve(); assert.equal((await work)?.status, "lost"); assert.equal(q.outcomes.length, 0);
    } finally { release.resolve(); await app.close(); source.cleanup(); }
});

it("drains a pending claim and its failed admission before disposing the adapter", async () => {
    const q = queue(), entered = deferred(), release = deferred(); let disposed = false;
    const claim = q.adapter.claim; q.adapter.claim = async lease => { entered.resolve(); await release.promise; assert.equal(disposed, false); return claim(lease); };
    const source = fixture(q.adapter, () => assert.fail("No execution admitted after close"), { cleanup() { disposed = true; } });
    const app = await new BoringApi().createApp(source.api);
    try {
        await app.execute({ identity: user }, ctx => source.port.enqueue(ctx.execution, { value: "x" }));
        const work = app.runJob(); await entered.promise; const closing = app.close(); await delay(10); assert.equal(disposed, false);
        release.resolve(); assert.equal((await work)?.status, "retry"); await closing; assert.equal(disposed, true);
    } finally { release.resolve(); await app.close(); source.cleanup(); }
});

it("reports heartbeat I/O failure to the supervisor only after the running operation settles", async () => {
    const q = queue(), entered = deferred(), release = deferred();
    q.adapter.renew = async () => { throw new Error("database unavailable"); };
    const source = fixture(q.adapter, async () => { entered.resolve(); await release.promise; });
    const app = await new BoringApi().createApp(source.api);
    try {
        await app.execute({ identity: user }, ctx => source.port.enqueue(ctx.execution, { value: "x" }));
        const work = app.runJob({ leaseMs: 30 }); let settled = false;
        const rejected = assert.rejects(work, /database unavailable/).then(() => { settled = true; });
        await entered.promise; await delay(35); assert.equal(settled, false); assert.equal(q.outcomes.length, 0);
        release.resolve(); await rejected; assert.equal(q.outcomes.length, 0);
    } finally { release.resolve(); await app.close(); source.cleanup(); }
});
