import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { BoringApi, commandFailure, eventPublication, scheduleDue, triggerId, requirePermissions, ShutdownTimeoutError } from "../src";
import type { TriggerAdapter, SetupContext, ScheduleTiming, StoredJob, ExecutionContext } from "../src";
const identity = { kind: "machine" as const, id: "configured", permissions: ["create"] };
const producer = { kind: "user" as const, id: "producer", permissions: [] };
const timing: ScheduleTiming = { startAt: 1000, everyMs: 100, missed: "catch-up", maxCatchUp: 3, overlap: "allow" };
const policy = { maxAttempts: 2, retryDelayMs: 1, timeoutMs: 1000 };
const defer = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
function queue() {
    const jobs: StoredJob[] = [], errors: string[] = [];
    const adapter: TriggerAdapter = {
        async enqueue(job) { jobs.push(job); },
        async claim(_lease, kind) { const index = jobs.findIndex(j => j.name.startsWith(`@${kind}/`)); if (index < 0) return; return { ...jobs.splice(index, 1)[0], attempt: 1, token: "claim" }; },
        async renew() { return true; }, async succeed() { return true; }, async fail(_claim, error) { errors.push(error.code); return true; },
        async acceptEvent(event, deliveries) { jobs.push(...deliveries); return { id: event.id, deliveries: deliveries.map(j => j.id) }; },
        async schedule() { return []; },
    };
    return { adapter, jobs, errors };
}
function fixture(adapter: TriggerAdapter, handler: (ctx: any) => any, options: { cleanup?: () => void; permissions?: string[]; input?: unknown; schema?: z.ZodTypeAny; second?: boolean } = {}) {
    const root = mkdtempSync(join(tmpdir(), "boring-triggers-"));
    const support = join(root, "support.cjs"); writeFileSync(support, "module.exports = {};");
    Object.assign(require(support), { schema: options.schema ?? z.object({ value: z.string() }).strict(), handler,
        setup(ctx: SetupContext) {
            const config = { identity: { ...identity, permissions: options.permissions ?? identity.permissions } };
            ctx.commands({ ...config, tenantId: "command-tenant" }); ctx.events(adapter, config); ctx.schedules(adapter, config);
            ctx.publications(adapter, { identity: { kind: "machine", id: "publisher", permissions: [] } });
            ctx.onClose("fixture", () => options.cleanup?.()); return {};
        } });
    const write = (name: string, text: string) => { const file = join(root, name); mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, text); };
    write("api/+setup.js", `exports.setup = require(${JSON.stringify(support)}).setup;`);
    const preamble = `const s = require(${JSON.stringify(support)}); exports.handler = s.handler;`;
    write("commands/create/command.js", preamble + `exports.input=s.schema; exports.output=s.schema; exports.timeoutMs=1000;`);
    write("schedules/create/schedule.js", preamble + `exports.payload=s.schema; exports.input=${JSON.stringify(options.input ?? { value: "scheduled" })}; exports.version=1; exports.timing=${JSON.stringify(timing)}; exports.policy=${JSON.stringify(policy)};`);
    for (const name of options.second ? ["create", "observe"] : ["create"]) write(`events/${name}/event.js`, preamble + `exports.payload=s.schema; exports.event={type:'created',version:1}; exports.version=1; exports.policy=${JSON.stringify(policy)};`);
    return { root, api: join(root, "api"), cleanup() { delete require.cache[support]; rmSync(root, { recursive: true, force: true }); } };
}
it("defines inclusive UTC interval boundaries, bounded newest catch-up, skip and latest with monotone cursors", () => {
    assert.deepEqual(scheduleDue(timing, undefined, 999), { due: [], cursor: undefined });
    assert.deepEqual(scheduleDue(timing, undefined, 1000), { due: [1000], cursor: 1000 });
    assert.deepEqual(scheduleDue(timing, undefined, 2050), { due: [1800, 1900, 2000], cursor: 2000 });
    assert.deepEqual(scheduleDue(timing, 2000, 1950), { due: [], cursor: 2000 });
    assert.deepEqual(scheduleDue({ ...timing, missed: "skip", maxCatchUp: 1 }, 1000, 1300), { due: [], cursor: 1300 });
    assert.deepEqual(scheduleDue({ ...timing, missed: "skip", maxCatchUp: 1 }, 1000, 1199), { due: [1100], cursor: 1100 });
    assert.deepEqual(scheduleDue({ ...timing, missed: "latest", maxCatchUp: 1 }, undefined, 2050), { due: [2000], cursor: 2000 });
    for (const change of [{ everyMs: 0 }, { startAt: -1 }, { missed: "cron" }, { maxCatchUp: 101 }, { overlap: "exclusive" }]) assert.throws(() => scheduleDue({ ...timing, ...change } as ScheduleTiming, undefined, 2000));
    const dst = Date.parse("2026-10-25T00:00:00Z");
    assert.deepEqual(scheduleDue({ ...timing, startAt: dst, everyMs: 3600000 }, undefined, dst + 7200000).due, [dst, dst + 3600000, dst + 7200000]);
    assert.equal(triggerId("schedule", "create", 1, 1000), triggerId("schedule", "create", 1, 1000));
    assert.notEqual(triggerId("schedule", "create", 1, 1000), triggerId("schedule", "create", 1, 1100));
});
it("validates command input/output, uses configured grants/tenant, and never retries a command", async () => {
    const q = queue(); let calls = 0; const seen: ExecutionContext[] = [];
    const f = fixture(q.adapter, ctx => { calls++; seen.push(ctx.execution); requirePermissions(ctx.execution.identity.permissions, "create"); return ctx.input; });
    const app = await new BoringApi().createApp(f.api);
    try {
        assert.deepEqual(await app.command("create", { value: "ok" }), { value: "ok" });
        assert.equal(seen[0].identity?.id, "configured"); assert.equal(seen[0].tenantId, "command-tenant"); assert.equal(seen[0].signal.aborted, true);
        await assert.rejects(app.command("create", { value: 3 }), { code: "invalid_input" });
        await assert.rejects(app.command("absent", {}), { code: "unknown_command" });
        await assert.rejects(app.command("create", { value: "x", permissions: ["admin"] }), { code: "invalid_input" });
        assert.equal(calls, 1);
    } finally { await app.close(); f.cleanup(); }
    const denied = fixture(q.adapter, ctx => { requirePermissions(ctx.execution.identity.permissions, "create"); return ctx.input; }, { permissions: [] });
    const noGrants = await new BoringApi().createApp(denied.api);
    try { await assert.rejects(noGrants.command("create", { value: "x" }), { code: "forbidden" }); }
    finally { await noGrants.close(); denied.cleanup(); }
    const output = fixture(q.adapter, () => ({ invalid: true })); const invalid = await new BoringApi().createApp(output.api);
    try { await assert.rejects(invalid.command("create", { value: "x" }), { code: "invalid_output" }); }
    finally { await invalid.close(); output.cleanup(); }
    assert.equal(commandFailure(new SyntaxError("json")).exitCode, 2);
});
it("validates all consumers before durable ingress and isolates origin from consumer grants/correlation", async () => {
    const q = queue(); const seen: any[] = [];
    const f = fixture(q.adapter, ctx => { seen.push(ctx); }, { second: true, schema: z.object({ value: z.string().transform(v => v + "!") }).strict() });
    const app = await new BoringApi().createApp(f.api);
    try {
        const event = { id: triggerId("input"), type: "created", version: 1, payload: { value: "hello" } };
        await assert.rejects(app.acceptEvent({ identity: producer }, { ...event, type: "unknown" }), { code: "unknown_event" });
        await assert.rejects(app.acceptEvent({ identity: producer }, { ...event, version: 2 }), { code: "incompatible_event" });
        await assert.rejects(app.acceptEvent({ identity: producer }, { ...event, payload: { value: 1 } }), { code: "invalid_input" });
        assert.equal(q.jobs.length, 0);
        const receipt = await app.acceptEvent({ identity: producer, tenantId: "trusted", correlationId: "origin" }, event);
        assert.equal(receipt.deliveries.length, 2); assert.notEqual(receipt.deliveries[0], receipt.deliveries[1]);
        assert.deepEqual((q.jobs[0].payload as any).data, { value: "hello" });
        for (let i = 0; i < 2; i++) assert.equal((await app.runJob({ kind: "event" }))?.status, "succeeded");
        for (const ctx of seen) { assert.deepEqual(ctx.execution.identity, identity); assert.equal(ctx.execution.tenantId, "trusted"); assert.equal(ctx.delivery.origin.correlationId, "origin"); assert.equal(ctx.payload.value, "hello!"); assert.equal(ctx.event.id, event.id); }
        assert.notEqual(seen[0].execution, seen[1].execution); assert.notEqual(seen[0].execution.correlationId, seen[1].execution.correlationId);
    } finally { await app.close(); f.cleanup(); }
});
it("attests publication contexts and returns canonical deeply immutable intents", async () => {
    const event = { id: triggerId("publication-attestation"), type: "created", version: 1, payload: { nested: { values: ["original"] } } };
    assert.throws(() => eventPublication({ identity: producer, tenantId: "forged", correlationId: "forged", throwIfAborted() {} } as any, event, policy),
        /framework-created execution context/);
    const root = mkdtempSync(join(tmpdir(), "boring-publication-attestation-")); mkdirSync(join(root, "api"));
    const app = await new BoringApi().createApp(join(root, "api"));
    try {
        const [first, secondVersion] = await app.execute({ identity: producer, tenantId: "tenant", correlationId: "origin" }, ({ execution }) => [
            eventPublication(execution, event, policy),
            eventPublication(execution, { ...event, version: 2 }, policy),
        ]);
        assert.equal(first.id, secondVersion.id, "event version is conflict data, not part of the ingress identity");
        assert.equal(Object.isFrozen(first), true);
        assert.equal(Object.isFrozen(first.origin), true);
        assert.equal(Object.isFrozen(first.origin.identity), true);
        assert.equal(Object.isFrozen(first.payload), true);
        assert.equal(Object.isFrozen(first.payload.event), true);
        assert.equal(Object.isFrozen(first.payload.event.payload), true);
        assert.equal(Object.isFrozen((first.payload.event.payload as any).nested.values), true);
        assert.throws(() => { (first.origin.identity as any).id = "mutated"; }, TypeError);
        assert.throws(() => { ((first.payload.event.payload as any).nested.values as string[]).push("mutated"); }, TypeError);
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});
it("delivers durable publication intents with publisher identity and original provenance kept separate", async () => {
    const q = queue(); const seen: any[] = [];
    const f = fixture(q.adapter, ctx => { seen.push(ctx); });
    const app = await new BoringApi().createApp(f.api);
    try {
        const event = { id: triggerId("published"), type: "created", version: 1, payload: { value: "published" } };
        const intent = await app.execute({ identity: producer, tenantId: "tenant-a", correlationId: "business-origin" }, ({ execution }) =>
            eventPublication(execution, event, policy));
        await q.adapter.enqueue(intent);
        assert.equal((await app.runJob({ kind: "publication" }))?.status, "succeeded");
        assert.equal(q.jobs.length, 1);
        assert.equal((await app.runJob({ kind: "event" }))?.status, "succeeded");
        assert.equal(seen[0].execution.identity.id, "configured");
        assert.equal(seen[0].execution.tenantId, "tenant-a");
        assert.equal(seen[0].delivery.origin.correlationId, "business-origin");
        assert.equal(seen[0].payload.value, "published");
    } finally { await app.close(); f.cleanup(); }
});
it("retains incompatible event metadata without invoking the consumer", async () => {
    const q = queue(); const f = fixture(q.adapter, () => assert.fail("must not execute")); const app = await new BoringApi().createApp(f.api);
    try {
        await app.acceptEvent({ identity: producer }, { id: triggerId("mismatch"), type: "created", version: 1, payload: { value: "a" } });
        (q.jobs[0].payload as any).metadata.type = "different";
        assert.equal((await app.runJob({ kind: "event" }))?.status, "failed"); assert.deepEqual(q.errors, ["invalid_payload"]);
    } finally { await app.close(); f.cleanup(); }
});
it("validates schedule input before adapter I/O and drains in-flight durable ingress through shutdown timeout", async () => {
    const q = queue(), entered = defer(), release = defer(); let disposed = false;
    q.adapter.schedule = async () => { entered.resolve(); await release.promise; assert.equal(disposed, false); return []; };
    const f = fixture(q.adapter, () => {}, { cleanup() { disposed = true; } });
    const app = await new BoringApi().createApp(f.api, { shutdownGraceMs: 1, shutdownTimeoutMs: 10 });
    try {
        const tick = app.tick(); const settled = assert.rejects(tick, { code: "cancelled" }); await entered.promise;
        await assert.rejects(app.close(), ShutdownTimeoutError); assert.equal(disposed, false);
        release.resolve(); await settled; await app.closed; assert.equal(disposed, true);
    } finally { release.resolve(); await app.closed; f.cleanup(); }
    const bad = fixture(q.adapter, () => {}, { input: { value: 1 } }); const invalid = await new BoringApi().createApp(bad.api);
    try { await assert.rejects(invalid.tick(), { code: "invalid_input" }); } finally { await invalid.close(); bad.cleanup(); }
});
it("owns command resources until actual settlement after deadline or cancellation", async () => {
    for (const mode of ["deadline", "cancelled"]) {
        const q = queue(), entered = defer(), release = defer(); let disposed = false;
        const f = fixture(q.adapter, async ctx => { entered.resolve(); await release.promise; assert.equal(disposed, false); return ctx.input; }, { cleanup() { disposed = true; } });
        const app = await new BoringApi().createApp(f.api, { shutdownGraceMs: 1, shutdownTimeoutMs: 10 });
        const cancel = new AbortController();
        try {
            const run = app.command("create", { value: "x" }, { signal: cancel.signal, timeoutMs: mode === "deadline" ? 5 : 1000 });
            const rejected = assert.rejects(run, { code: mode }); await entered.promise;
            if (mode === "cancelled") cancel.abort(); else await new Promise(r => setTimeout(r, 15));
            await assert.rejects(app.close(), ShutdownTimeoutError); assert.equal(disposed, false);
            release.resolve(); await rejected; await app.closed; assert.equal(disposed, true);
        } finally { release.resolve(); await app.closed; f.cleanup(); }
    }
});
