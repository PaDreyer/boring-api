import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { BoringApi, ExecutionContext, LifecycleError, ShutdownTimeoutError } from "../src";
import { SetupContext } from "../src/core/setupContext";
import { Context } from "../src/core/context";
import { z } from "zod";

const machine = { kind: "machine" as const, id: "worker", permissions: [] as string[] };
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(hooks: { setup?: (ctx: SetupContext<any>) => unknown; handler?: (ctx: Context) => unknown; authenticate?: (ctx: Context) => unknown; error?: (ctx: Context) => unknown; config?: { schema: z.ZodTypeAny; load: (env: Record<string, string | undefined>) => unknown } } = {}) {
    const root = mkdtempSync(join(tmpdir(), "boring-lifecycle-"));
    const support = join(root, "../", `${root.split("/").pop()}.cjs`);
    writeFileSync(support, "module.exports = {};\n");
    Object.assign(require(support), { handler: () => "ok", ...hooks });
    const ref = JSON.stringify(support);
    writeFileSync(join(root, "get.js"), `exports.handler = require(${ref}).handler;`);
    if (hooks.setup) writeFileSync(join(root, "+setup.js"), `exports.setup = require(${ref}).setup;`);
    if (hooks.authenticate) writeFileSync(join(root, "+auth.js"), `exports.authenticate = require(${ref}).authenticate;`);
    if (hooks.error) writeFileSync(join(root, "+error.js"), `exports.handler = require(${ref}).error;`);
    if (hooks.config) writeFileSync(join(root, "+config.js"), `module.exports = require(${ref}).config;`);
    return { root, remove() { rmSync(root, { recursive: true, force: true }); rmSync(support); delete require.cache[support]; } };
}

it("validates an isolated configuration snapshot before acquiring resources", async () => {
    let starts = 0;
    const env = { NAME: "first" };
    const source = fixture({ config: { schema: z.object({ name: z.string().min(1) }), load: env => ({ name: env.NAME }) },
        setup(ctx) { starts++; return { name: ctx.config.name }; } });
    try {
        await assert.rejects(new BoringApi().createApp(source.root, { env: {} }), z.ZodError);
        await assert.rejects(new BoringApi().createApp(source.root, { env: { NAME: "bad", [Symbol("hidden")]: "bad" } }), /symbol keys/);
        assert.equal(starts, 0);
        const first = await new BoringApi().createApp<{ name: string }>(source.root, { env });
        env.NAME = "second";
        const second = await new BoringApi().createApp<{ name: string }>(source.root, { env });
        try {
            assert.equal(await first.execute({ identity: machine }, ctx => ctx.services.name), "first");
            assert.equal(await second.execute({ identity: machine }, ctx => ctx.services.name), "second");
        } finally { await Promise.all([first.close(), second.close()]); }
    } finally { source.remove(); }
});

it("loads implicit and explicit native process environments as frozen plain snapshots", async () => {
    const source = fixture({ config: { schema: z.object({}), load(env) {
        assert.equal(Object.getPrototypeOf(env), Object.prototype);
        assert.equal(Object.isFrozen(env), true);
        assert.notEqual(env, process.env);
        assert.equal(env.PATH, process.env.PATH);
        return {};
    } } });
    try {
        for (const options of [undefined, { env: process.env }]) {
            const app = await new BoringApi().createApp(source.root, options);
            await app.close();
        }
    }
    finally { source.remove(); }
});

it("unwinds partial startup in reverse order and preserves every failure", async () => {
    const events: string[] = [];
    const startup = new Error("startup"), cleanup = new Error("cleanup");
    const source = fixture({ async setup(ctx) {
        ctx.onClose("first", () => { events.push("first"); });
        ctx.onClose("second", async () => { events.push("second"); throw cleanup; });
        throw startup;
    } });
    try {
        await assert.rejects(new BoringApi().createApp(source.root), error => {
            assert.ok(error instanceof LifecycleError);
            assert.equal(error.errors[0], startup);
            assert.equal(((error.errors[1] as LifecycleError).errors[0] as LifecycleError).errors[0], cleanup);
            return true;
        });
        assert.deepEqual(events, ["second", "first"]);
    } finally { source.remove(); }
});

it("cleans up once across concurrent/repeated shutdown and continues after cleanup errors", async () => {
    const events: string[] = [];
    const source = fixture({ setup(ctx) {
        ctx.onClose("one", () => { events.push("one"); });
        ctx.onClose("two", () => { events.push("two"); throw new Error("failed cleanup"); });
        return {};
    } });
    try {
        const app = await new BoringApi().createApp(source.root);
        const closing = app.close();
        assert.equal(app.close(), closing);
        await assert.rejects(closing, LifecycleError);
        assert.equal(app.close(), closing);
        await assert.rejects(app.closed, LifecycleError);
        assert.equal(app.state, "closed");
        assert.deepEqual(events, ["two", "one"]);
        await assert.rejects(app.execute({ identity: machine }, () => "bad"), { code: "unavailable" });
    } finally { source.remove(); }
});

it("isolates parallel executions, trusted identity snapshots, tenants and correlation across apps", async () => {
    const source = fixture();
    try {
        const apps = await Promise.all([new BoringApi().createApp(source.root), new BoringApi().createApp(source.root)]);
        try {
            await Promise.all(Array.from({ length: 16 }, async (_, index) => {
                const identity = { ...machine, id: `actor-${index}`, permissions: ["read"] };
                let context!: ExecutionContext;
                const result = apps[index % 2].execute({ identity, tenantId: `tenant-${index}`, correlationId: `correlation-${index}` }, async ({ execution }) => {
                    context = execution;
                    await delay(4);
                    assert.equal(execution.identity!.id, `actor-${index}`);
                    assert.deepEqual(execution.identity!.permissions, ["read"]);
                    assert.equal(execution.tenantId, `tenant-${index}`);
                    assert.equal(execution.correlationId, `correlation-${index}`);
                    assert.ok(Object.isFrozen(execution.identity));
                    return index;
                });
                identity.id = "changed"; identity.permissions.push("write");
                assert.equal(await result, index);
                assert.throws(() => context.throwIfAborted(), { code: "ended" });
            }));
            await apps[0].close();
            assert.equal(await apps[1].execute({ identity: machine }, () => "still ready"), "still ready");
        } finally { await Promise.all(apps.map(app => app.close())); }
    } finally { source.remove(); }
});

it("stops admission, drains accepted work, and keeps resources until that work actually settles", async () => {
    const entered = deferred(), release = deferred(); let disposed = false;
    const source = fixture({ setup(ctx) { ctx.onClose("resource", () => { disposed = true; }); } });
    try {
        const app = await new BoringApi().createApp(source.root, { shutdownGraceMs: 100, shutdownTimeoutMs: 200 });
        const work = app.execute({ identity: machine }, async () => { entered.resolve(); await release.promise; assert.equal(disposed, false); return "done"; });
        await entered.promise;
        const closing = app.close();
        assert.equal(app.ready, false);
        await assert.rejects(app.execute({ identity: machine }, () => "bad"), { code: "unavailable" });
        assert.equal(disposed, false);
        release.resolve();
        assert.equal(await work, "done");
        await closing;
        assert.equal(disposed, true);
    } finally { source.remove(); }
});

it("cancels cooperative work after grace and runs resource cleanup afterwards", async () => {
    const events: string[] = [];
    const source = fixture({ setup(ctx) { ctx.onClose("resource", () => { events.push("dispose"); }); } });
    try {
        const app = await new BoringApi().createApp(source.root, { shutdownGraceMs: 10, shutdownTimeoutMs: 1000 });
        const work = app.execute({ identity: machine }, async ({ execution }) => {
            try { await new Promise<void>(resolve => execution.signal.addEventListener("abort", () => resolve(), { once: true })); execution.throwIfAborted(); }
            finally { events.push("work cleanup"); }
        });
        const rejected = assert.rejects(work, { code: "cancelled" });
        await app.close(); await rejected;
        assert.deepEqual(events, ["work cleanup", "dispose"]);
    } finally { source.remove(); }
});

it("bounds shutdown waiting without freeing resources under non-cooperative work", async () => {
    const release = deferred(); let disposed = false;
    const source = fixture({ setup(ctx) { ctx.onClose("resource", () => { disposed = true; }); } });
    try {
        const app = await new BoringApi().createApp(source.root, { shutdownGraceMs: 5, shutdownTimeoutMs: 15 });
        const work = app.execute({ identity: machine }, async () => { await release.promise; assert.equal(disposed, false); });
        const rejected = assert.rejects(work, { code: "cancelled" });
        await assert.rejects(app.close(), ShutdownTimeoutError);
        assert.equal(app.state, "draining"); assert.equal(disposed, false);
        release.resolve(); await rejected; await app.closed;
        assert.equal(disposed, true); assert.equal(app.state, "closed");
    } finally { source.remove(); }
});

it("enforces caller cancellation and capped deadlines while awaiting operation finally blocks", async () => {
    const source = fixture();
    try {
        const app = await new BoringApi().createApp(source.root, { executionTimeoutMs: 15 });
        try {
            const controller = new AbortController(); controller.abort(); let invoked = false;
            await assert.rejects(app.execute({ identity: machine, signal: controller.signal }, () => { invoked = true; }), { code: "cancelled" });
            assert.equal(invoked, false);
            let settled = false;
            await assert.rejects(app.execute({ identity: machine, timeoutMs: 1000 }, async ({ execution }) => {
                assert.ok(execution.deadline <= Date.now() + 15);
                try { await delay(30); } finally { settled = true; }
                return "too late";
            }), { code: "deadline" });
            assert.equal(settled, true);
            await assert.rejects(app.execute({ identity: machine }, ({ execution }) =>
                new Promise<void>((_resolve, reject) => execution.signal.addEventListener("abort", () => reject(execution.signal.reason), { once: true }))),
                { code: "deadline" });
        } finally { await app.close(); }
    } finally { source.remove(); }
});

it("keeps the HTTP execution and resources active through shutdown cancellation", async () => {
    const entered = deferred(), release = deferred(); let captured!: Context; let disposed = false;
    const source = fixture({ setup(ctx) { ctx.onClose("resource", () => { disposed = true; }); },
        authenticate: () => ({ kind: "user", id: "http-user", permissions: ["read"], tenantId: "trusted-tenant" }),
        async handler(ctx) { captured = ctx; entered.resolve(); await release.promise; ctx.execution.throwIfAborted(); return "done"; } });
    try {
        const app = await new BoringApi().createApp(source.root, { shutdownGraceMs: 5, shutdownTimeoutMs: 15 });
        const server = await app.listen(0);
        const request = fetch(`http://127.0.0.1:${(server.address() as any).port}/`);
        await entered.promise;
        assert.equal(captured.execution.identity!.id, "http-user");
        assert.equal(captured.execution.tenantId, "trusted-tenant");
        assert.equal(captured.session, captured.execution.identity);
        await assert.rejects(app.close(), ShutdownTimeoutError);
        assert.equal(disposed, false);
        release.resolve();
        const response = await request;
        assert.equal(response.status, 503);
        await app.closed; assert.equal(disposed, true);
    } finally { source.remove(); }
});

it("releases setup resources when binding an HTTP listener fails", async () => {
    let disposals = 0;
    const source = fixture({ setup(ctx) { ctx.onClose("resource", () => { disposals++; }); } });
    try {
        const first = await new BoringApi().createApp(source.root);
        const server = await first.listen(0);
        try {
            await assert.rejects(new BoringApi().listen(source.root, (server.address() as any).port), { code: "EADDRINUSE" });
            assert.equal(disposals, 1);
        } finally { await first.close(); }
        assert.equal(disposals, 2);
    } finally { source.remove(); }
});


it("settles overlapping listener starts and shutdown without leaking listeners or repeating cleanup", { timeout: 2000 }, async () => {
    let disposals = 0;
    const source = fixture({ setup(ctx) { ctx.onClose("resource", () => { disposals++; }); } });
    const app = await new BoringApi().createApp(source.root);
    try {
        const starts = [app.listen(0), app.listen(0)];
        const rejected = starts.map(start => assert.rejects(start, { code: "unavailable" }));
        const closing = app.close();
        assert.equal(app.close(), closing);
        await closing;
        await Promise.all(rejected);
        assert.equal(app.state, "closed");
        assert.equal(disposals, 1);
    } finally { await app.close(); source.remove(); }
});

it("does not release resources after an early HTTP response until the handler settles", async () => {
    const release = deferred(); let disposed = false;
    const source = fixture({ setup(ctx) { ctx.onClose("resource", () => { disposed = true; }); },
        async handler(ctx) { ctx.send("accepted"); await release.promise; assert.equal(disposed, false); } });
    try {
        const app = await new BoringApi().createApp(source.root, { shutdownGraceMs: 1000, shutdownTimeoutMs: 2000 });
        const server = await app.listen(0);
        const response = await fetch(`http://127.0.0.1:${(server.address() as any).port}/`);
        assert.equal(await response.text(), "accepted");
        const closing = app.close();
        assert.equal(disposed, false);
        release.resolve(); await closing;
        assert.equal(disposed, true);
    } finally { source.remove(); }
});

it("preserves the same execution through awaited error hooks", async () => {
    let captured!: Context;
    const source = fixture({ authenticate: () => machine,
        handler(ctx) { captured = ctx; throw new Error("failure"); },
        async error(ctx) { await delay(5); assert.equal(ctx, captured); assert.equal(ctx.execution.signal.aborted, false); return { correlation: ctx.execution.correlationId }; } });
    try {
        const app = await new BoringApi().createApp(source.root);
        try {
            const server = await app.listen(0);
            const response = await fetch(`http://127.0.0.1:${(server.address() as any).port}/`);
            assert.equal(response.status, 500);
            assert.deepEqual(await response.json(), { correlation: captured.execution.correlationId });
            assert.equal(captured.execution.signal.aborted, true);
        } finally { await app.close(); }
    } finally { source.remove(); }
});

it("propagates HTTP disconnect cancellation and interrupts incomplete JSON input at the deadline", async () => {
    const entered = deferred(), completed = deferred();
    const source = fixture({ async handler(ctx) {
        entered.resolve();
        await new Promise<void>(resolve => ctx.execution.signal.addEventListener("abort", () => resolve(), { once: true }));
        completed.resolve(); ctx.execution.throwIfAborted();
    } });
    try {
        const app = await new BoringApi().createApp(source.root, { executionTimeoutMs: 100 });
        const server = await app.listen(0);
        try {
            const address = (server.address() as any).port;
            const abort = new AbortController();
            const response = fetch(`http://127.0.0.1:${address}/`, { signal: abort.signal });
            await entered.promise; abort.abort();
            await assert.rejects(response); await completed.promise;
            const { request } = await import("node:http");
            await new Promise<void>((resolve, reject) => {
                const req = request({ hostname: "127.0.0.1", port: address, method: "POST", headers: { "content-type": "application/json", "content-length": 100 } });
                req.once("error", () => resolve());
                req.once("response", () => reject(new Error("Incomplete input should disconnect")));
                req.write("{");
            });
        } finally { await app.close(); }
    } finally { source.remove(); }
});
