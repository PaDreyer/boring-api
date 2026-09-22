import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
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
function lifecycleCauses(error: unknown): unknown[] {
    return error instanceof LifecycleError ? error.errors.flatMap(lifecycleCauses) : [error];
}
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

it("deduplicates nested lifecycle causes by object identity without mutating their trees", () => {
    const unavailable = new Error("unavailable"), timeout = new Error("timeout"), cleanup = new Error("cleanup");
    const leaf = new LifecycleError("listener", [unavailable, cleanup]);
    const leafErrors = leaf.errors;
    const repeatedCleanup = new LifecycleError("outer", [leaf, cleanup]);
    assert.equal(repeatedCleanup.errors.length, 1);
    assert.equal(repeatedCleanup.errors[0], leaf);
    assert.equal(leaf.errors, leafErrors);
    assert.deepEqual(leaf.errors, [unavailable, cleanup]);

    const left = new LifecycleError("left", [unavailable, timeout]);
    const right = new LifecycleError("right", [timeout, cleanup]);
    const leftErrors = left.errors, rightErrors = right.errors;
    const overlapping = new LifecycleError("combined", [left, right]);
    assert.equal(overlapping.errors[0], left);
    assert.ok(overlapping.errors[1] instanceof LifecycleError);
    assert.notEqual(overlapping.errors[1], right);
    assert.equal((overlapping.errors[1] as LifecycleError).message, "right");
    assert.deepEqual((overlapping.errors[1] as LifecycleError).errors, [cleanup]);
    assert.equal((overlapping.errors[1] as LifecycleError).errors[0], cleanup);
    assert.equal(left.errors, leftErrors);
    assert.equal(right.errors, rightErrors);
    assert.deepEqual(right.errors, [timeout, cleanup]);

    const redundant = new LifecycleError("redundant", [unavailable, timeout]);
    const withoutRedundantSubtree = new LifecycleError("deduplicated", [left, redundant]);
    assert.deepEqual(withoutRedundantSubtree.errors, [left]);
    assert.equal(withoutRedundantSubtree.errors[0], left);
    assert.deepEqual(redundant.errors, [unavailable, timeout]);

    const empty = new LifecycleError("empty", []);
    const withOriginalEmpty = new LifecycleError("with empty", [empty]);
    assert.deepEqual(withOriginalEmpty.errors, [empty]);
    assert.equal(withOriginalEmpty.errors[0], empty);

    const primitives = new LifecycleError("primitive throws", ["failure", "failure", 1, 1]);
    assert.deepEqual(primitives.errors, ["failure", "failure", 1, 1]);
});

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

it("integrates structured telemetry, bounded metrics and infrastructure readiness with lifecycle ownership", async () => {
    const records: any[] = [];
    const order: string[] = [];
    let databaseReady = true;
    const source = fixture({ setup(ctx) {
        ctx.observability({ emit(record) { records.push(record); }, flush() { order.push("flush"); } });
        ctx.readiness("database", () => { if (!databaseReady) throw new Error("database unavailable"); }, { timeoutMs: 50 });
        ctx.onClose("database", () => { order.push("database.close"); });
        return {};
    } });
    try {
        const app = await new BoringApi().createApp(source.root);
        assert.deepEqual(app.health(), { status: "up", state: "ready" });
        assert.deepEqual(await app.readiness(), { status: "ready", state: "ready", checks: [{ name: "database", status: "up" }] });
        await app.execute({ identity: machine, correlationId: "successful" }, () => "ok");
        await assert.rejects(app.execute({ identity: machine, correlationId: "failed" }, () => { throw new Error("failure"); }), /failure/);
        databaseReady = false;
        assert.deepEqual(await app.readiness(), { status: "not_ready", state: "ready", checks: [{ name: "database", status: "down", error: "failed" }] });
        assert.ok(app.metrics().some(metric => metric.name === "boring_execution_results_total" && metric.labels.kind === "controlled"));
        await app.close();
        assert.deepEqual(order, ["flush", "database.close"]);
        assert.deepEqual(app.health(), { status: "down", state: "closed" });
        assert.equal((await app.readiness()).status, "not_ready");
        assert.ok(records.some(record => record.kind === "span" && record.traceId === "successful" && record.status === "ok"));
        assert.ok(records.some(record => record.kind === "span" && record.traceId === "failed" && record.status === "error"));
        assert.ok(records.some(record => record.kind === "log" && record.event === "execution.completed" && record.level === "info" &&
            record.correlationId === "successful" && record.attributes.kind === "controlled" && record.attributes.status === "ok"));
        assert.ok(records.some(record => record.kind === "log" && record.event === "execution.completed" && record.level === "error" &&
            record.correlationId === "failed" && record.attributes.kind === "controlled" && record.attributes.status === "error"));
        assert.ok(records.some(record => record.kind === "log" && record.event === "readiness.failed"));
        assert.equal(records.some(record => JSON.stringify(record).includes("database unavailable")), false);
        assert.equal(records.some(record => JSON.stringify(record).includes("permissions")), false);
    } finally { source.remove(); }
});

it("shares each in-flight readiness probe while keeping per-call timeout observers", async () => {
    const entered = deferred(), release = deferred();
    let calls = 0;
    const source = fixture({ setup(ctx) {
        ctx.readiness("database", async () => {
            calls++;
            if (calls === 1) { entered.resolve(); await release.promise; }
        }, { timeoutMs: 50 });
    } });
    try {
        const app = await new BoringApi().createApp(source.root);
        const first = app.readiness();
        await entered.promise;
        await delay(35);
        const second = app.readiness();
        assert.deepEqual(await first, { status: "not_ready", state: "ready", checks: [{ name: "database", status: "down", error: "timeout" }] });
        assert.equal(calls, 1);
        release.resolve();
        assert.deepEqual(await second, { status: "ready", state: "ready", checks: [{ name: "database", status: "up" }] });
        assert.equal(calls, 1);
        assert.equal((await app.readiness()).status, "ready");
        assert.equal(calls, 2);
        await app.close();
    } finally { source.remove(); }
});

it("records complete HTTP error telemetry and marks failures after an early response", async () => {
    const records: any[] = [];
    let calls = 0;
    const source = fixture({
        setup(ctx) { ctx.observability({ emit(record) { records.push(record); } }); },
        handler(ctx) {
            calls++;
            if (calls === 2) ctx.send({ accepted: true });
            throw new Error(calls === 1 ? "ordinary failure" : "failure after response");
        },
    });
    try {
        const app = await new BoringApi().createApp(source.root);
        try {
            const server = await app.listen(0);
            const url = `http://127.0.0.1:${(server.address() as any).port}/`;
            const ordinary = await fetch(url);
            assert.equal(ordinary.status, 500);
            const early = await fetch(url);
            assert.equal(early.status, 200);
            assert.deepEqual(await early.json(), { accepted: true });

            const errors = records.filter(record => record.kind === "log" && record.event === "http.error");
            assert.equal(errors.length, 2);
            assert.deepEqual(errors.map(record => record.message), ["Application operation failed", "Application operation failed"]);
            for (const record of errors) {
                assert.equal(record.level, "error");
                assert.equal(record.attributes.method, "GET");
                assert.equal(record.attributes.route, "/");
                assert.equal(record.attributes.errorKind, "unexpected");
                assert.equal(record.attributes.statusCode, 500);
                assert.equal(typeof record.attributes.durationMs, "number");
                assert.ok(record.attributes.durationMs >= 0);
            }
            assert.equal(records.filter(record => record.kind === "span" && record.name === "boring.http" && record.status === "error").length, 2);
        } finally { await app.close(); }
    } finally { source.remove(); }
});

it("exports stable HTTP routes and error categories without dynamic paths or raw failures", async () => {
    const records: any[] = [];
    const source = fixture({ setup(ctx) { ctx.observability({ emit(record) { records.push(record); } }); } });
    mkdirSync(join(source.root, "account", "[token]"), { recursive: true });
    writeFileSync(join(source.root, "account", "[token]", "get.js"), "exports.handler = () => { throw new Error('database password=super-secret'); };\n");
    try {
        const app = await new BoringApi().createApp(source.root);
        const server = await app.listen(0);
        try {
            const origin = `http://127.0.0.1:${(server.address() as any).port}`;
            assert.equal((await fetch(`${origin}/account/super-secret`)).status, 500);
            assert.equal((await fetch(`${origin}/missing/super-secret`)).status, 404);
            const completed = records.filter(record => record.kind === "log" && record.event === "http.completed");
            assert.deepEqual(completed.map(record => record.attributes.route), ["/account/:token", "<unmatched>"]);
            const failure = records.find(record => record.kind === "log" && record.event === "http.error");
            assert.equal(failure.message, "Application operation failed");
            assert.equal(failure.attributes.errorKind, "unexpected");
            assert.equal(JSON.stringify(records).includes("super-secret"), false);
            assert.equal(JSON.stringify(records).includes("database password"), false);
        } finally { await app.close(); }
    } finally { source.remove(); }
});

it("snapshots and validates custom operational attributes at emission", async () => {
    const records: any[] = [];
    const attributes: any = { phase: "before", count: 1 };
    const source = fixture({ setup(ctx) {
        ctx.observability({ emit(record) { records.push(record); } });
        ctx.logger.info("custom", "custom.event", undefined, attributes);
        attributes.phase = "after";
        assert.throws(() => ctx.logger.info("invalid", "custom.invalid", undefined, { nested: {} } as any), /finite primitive/);
    } });
    try {
        const app = await new BoringApi().createApp(source.root);
        const record = records.find(item => item.kind === "log" && item.event === "custom.event");
        assert.deepEqual(record.attributes, { phase: "before", count: 1 });
        assert.equal(Object.isFrozen(record.attributes), true);
        await app.close();
    } finally { source.remove(); }
});

it("keeps the framework logger separate from a consumer service named logger", async () => {
    const records: any[] = [];
    const businessLogger = Object.freeze({ kind: "business" });
    let setupContext!: SetupContext<any>;
    let frameworkLogger: unknown;
    const source = fixture({
        setup(ctx) {
            setupContext = ctx;
            frameworkLogger = ctx.logger;
            ctx.observability({ emit(record) { records.push(record); } });
            return { logger: businessLogger };
        },
        handler(ctx) {
            assert.equal(ctx.setup.logger, frameworkLogger);
            assert.equal(ctx.services.logger, businessLogger);
            throw new Error("HTTP failure");
        },
    });
    try {
        const app = await new BoringApi().createApp(source.root);
        assert.equal(setupContext.logger, frameworkLogger);
        assert.equal(setupContext.get("logger"), businessLogger);
        assert.equal(await app.execute({ identity: machine }, scope => scope.services.logger), businessLogger);
        const server = await app.listen(0);
        assert.equal((await fetch(`http://127.0.0.1:${(server.address() as any).port}/`)).status, 500);
        assert.ok(records.some(record => record.kind === "log" && record.event === "http.error"));
        assert.ok(records.some(record => record.kind === "log" && record.event === "http.completed"));
        await app.close();
    } finally { source.remove(); }
});

it("owns timed-out readiness probes until settlement and never returns a stale ready state", async () => {
    const entered = deferred(), release = deferred(); let disposed = false;
    const source = fixture({ setup(ctx) {
        ctx.observability({ emit() {} });
        ctx.readiness("database", async () => { entered.resolve(); await release.promise; assert.equal(disposed, false); }, { timeoutMs: 10 });
        ctx.onClose("database", () => { disposed = true; });
        return {};
    } });
    try {
        const app = await new BoringApi().createApp(source.root, { shutdownGraceMs: 5, shutdownTimeoutMs: 30 });
        const readiness = app.readiness();
        await entered.promise;
        const closing = app.close();
        const report = await readiness;
        assert.equal(report.status, "not_ready");
        assert.equal(report.state, "draining");
        await assert.rejects(closing, ShutdownTimeoutError);
        assert.equal(disposed, false);
        release.resolve();
        await app.closed;
        assert.equal(disposed, true);
        assert.deepEqual(await app.readiness(), { status: "not_ready", state: "closed", checks: [] });
    } finally { source.remove(); }
});

it("rejects the bounded close on flush timeout but owns late flush failure through disposal", async () => {
    const entered = deferred(), release = deferred();
    const lateFailure = new Error("late flush failure");
    let disposed = false;
    const source = fixture({ setup(ctx) {
        ctx.observability({ emit() {}, async flush() { entered.resolve(); await release.promise; throw lateFailure; } }, { flushTimeoutMs: 10 });
        ctx.onClose("resource", () => { disposed = true; });
    } });
    try {
        const app = await new BoringApi().createApp(source.root, { shutdownGraceMs: 5, shutdownTimeoutMs: 500 });
        const closing = app.close();
        await entered.promise;
        let timeoutFailure: unknown;
        await assert.rejects(closing, error => {
            timeoutFailure = error;
            assert.match((error as Error).message, /Operational flush timed out/);
            return true;
        });
        assert.equal(disposed, false);
        release.resolve();
        await assert.rejects(app.closed, error => {
            const causes = lifecycleCauses(error);
            assert.ok(causes.includes(timeoutFailure));
            assert.ok(causes.includes(lateFailure));
            return true;
        });
        assert.equal(disposed, true);
    } finally { source.remove(); }
});

it("preserves arbitrary flush errors with errors fields instead of structurally unpacking them", async () => {
    const nested = new Error("must remain nested application data");
    const flushFailure = Object.assign(new Error("adapter flush failed"), { errors: [nested] });
    const originalStack = flushFailure.stack;
    let disposed = false;
    const source = fixture({ setup(ctx) {
        ctx.observability({ emit() {}, flush() { throw flushFailure; } });
        ctx.onClose("resource", () => { disposed = true; });
    } });
    try {
        const app = await new BoringApi().createApp(source.root);
        await assert.rejects(app.close(), error => error === flushFailure);
        await assert.rejects(app.closed, error => {
            const causes = lifecycleCauses(error);
            assert.ok(causes.includes(flushFailure));
            assert.equal(causes.includes(nested), false);
            assert.equal(flushFailure.message, "adapter flush failed");
            assert.equal(flushFailure.stack, originalStack);
            return true;
        });
        assert.equal(disposed, true);
    } finally { source.remove(); }
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

it("keeps an unreachable BoringApi.listen owner until delayed startup cleanup settles", async () => {
    const occupied = fixture();
    const flushEntered = deferred(), releaseFlush = deferred();
    const lateFlushFailure = new Error("late startup flush failure");
    let disposed = false;
    const failing = fixture({ setup(ctx) {
        ctx.observability({ emit() {}, async flush() { flushEntered.resolve(); await releaseFlush.promise; throw lateFlushFailure; } }, { flushTimeoutMs: 5 });
        ctx.onClose("resource", () => { disposed = true; });
    } });
    try {
        const owner = await new BoringApi().createApp(occupied.root);
        const server = await owner.listen(0);
        try {
            let startupSettled = false;
            const startup = new BoringApi().listen(failing.root, (server.address() as any).port,
                { shutdownGraceMs: 5, shutdownTimeoutMs: 50 }).finally(() => { startupSettled = true; });
            await flushEntered.promise;
            await delay(15);
            assert.equal(startupSettled, false);
            assert.equal(disposed, false);
            releaseFlush.resolve();
            await assert.rejects(startup, error => {
                const causes = lifecycleCauses(error);
                assert.ok(causes.some(cause => (cause as NodeJS.ErrnoException)?.code === "EADDRINUSE"));
                assert.ok(causes.some(cause => cause instanceof Error && /Operational flush timed out/.test(cause.message)));
                assert.ok(causes.includes(lateFlushFailure));
                return true;
            });
            assert.equal(disposed, true);
        } finally { await owner.close(); }
    } finally { occupied.remove(); failing.remove(); }
});

it("attaches the process owner's HTTP runtime-error policy before listen resolves", async () => {
    const source = fixture({});
    try {
        const app = await new BoringApi().createApp(source.root);
        const failures: Error[] = [];
        const server = await app.listen(0, undefined, error => failures.push(error));
        const failure = new Error("listener runtime failure");
        server.emit("error", failure);
        assert.deepEqual(failures, [failure]);
        await assert.rejects(app.closed, error => lifecycleCauses(error).includes(failure));
    } finally { source.remove(); }
});

it("publishes the shared close promise before synchronous listener shutdown callbacks", async () => {
    const source = fixture();
    try {
        const app = await new BoringApi().createApp(source.root);
        const server = await app.listen(0);
        const nativeClose = server.close.bind(server);
        let reentrant!: Promise<void>;
        server.close = ((callback?: (error?: Error) => void) => {
            reentrant = app.close();
            return nativeClose(callback);
        }) as typeof server.close;
        const closing = app.close();
        assert.equal(reentrant, closing);
        await closing;
    } finally { source.remove(); }
});

it("owns every listener runtime error and catches observer failures", async () => {
    const source = fixture();
    const first = new Error("first runtime failure"), second = new Error("second runtime failure"), observer = new Error("observer failure");
    try {
        const app = await new BoringApi().createApp(source.root);
        const observed: Error[] = [];
        const server = await app.listen(0, undefined, error => {
            observed.push(error);
            if (error === first) throw observer;
        });
        server.emit("error", first);
        server.emit("error", second);
        assert.equal(app.state, "draining");
        await assert.rejects(app.closed, error => {
            const causes = lifecycleCauses(error);
            assert.ok(causes.includes(first));
            assert.ok(causes.includes(second));
            assert.ok(causes.includes(observer));
            return true;
        });
        assert.deepEqual(observed, [first, second]);
        await assert.rejects(app.close(), LifecycleError);
    } finally { source.remove(); }
});

it("makes BoringApi.listen own runtime failures without exposing the native server", async () => {
    const source = fixture();
    const runtimeFailure = new Error("convenience listener failure");
    try {
        const app = await new BoringApi().listen(source.root, 0);
        const server = [...(app as any).servers.keys()][0] as import("node:http").Server;
        server.emit("error", runtimeFailure);
        await assert.rejects(app.closed, error => {
            assert.ok(lifecycleCauses(error).includes(runtimeFailure));
            return true;
        });
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
