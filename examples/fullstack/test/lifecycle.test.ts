import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { it } from "node:test";
import { BoringApi, ExecutionError, LifecycleError } from "@boringapi/core";
import type { Services } from "../api/$types";
import type { Actor } from "../modules/access/schemas";
import type { Order } from "../modules/orders/schemas";
import { createOrder } from "../executions/create-order";

/** A pg protocol test double: all application, facade, service and adapter code is real. */
it("shares orders authorization, transactions, rollback, cancellation and pool ownership across HTTP and controlled execution", async () => {
    const pg = require("pg");
    const OriginalPool = pg.Pool;
    const identityModule = require("../infra/identity");
    const originalIdentity = identityModule.createIdentity;
    identityModule.createIdentity = (token: string) => {
        const provider = originalIdentity(token);
        return { authenticate(header: string | undefined) {
            if (header === `Bearer denied:${token}`) return { kind: "user", id: "denied", permissions: [] };
            return provider.authenticate(header);
        } };
    };
    const trace: string[] = [];
    const records = new Map<string, Order>();
    let closed = 0, clients = 0;
    let releaseAudit!: () => void;
    let enteredAudit!: () => void;
    const auditEntered = new Promise<void>(resolve => { enteredAudit = resolve; });
    const auditRelease = new Promise<void>(resolve => { releaseAudit = resolve; });
    pg.Pool = class {
        on() { return this; }
        async end() { assert.equal(clients, 0); closed++; trace.push("pool.close"); }
        async connect() {
            assert.equal(closed, 0); clients++;
            let pending: Order | undefined;
            return {
                async query(sql: string, values: unknown[] = []) {
                    if (sql === "BEGIN") trace.push("begin");
                    else if (sql === "SET LOCAL synchronous_commit = on") trace.push("sync");
                    else if (sql.startsWith("INSERT INTO orders")) {
                        trace.push("insert");
                        pending = { id: values[0] as string, item: values[1] as string, quantity: values[2] as number };
                    } else if (sql.startsWith("INSERT INTO order_events")) {
                        trace.push("audit");
                        if (pending?.item === "fail-audit" || pending?.item === "fail-rollback") throw new Error("audit rejected");
                        if (pending?.item === "cancel-audit") { enteredAudit(); await auditRelease; }
                    } else if (sql.startsWith("INSERT INTO boring_jobs")) {
                        trace.push("publication");
                        return { rows: [{ id: values[0] }], rowCount: 1 };
                    } else if (sql.startsWith("SELECT id")) return { rows: records.has(values[0] as string) ? [records.get(values[0] as string)] : [] };
                    else if (sql === "COMMIT") { trace.push("commit"); if (pending) records.set(pending.id, pending); }
                    else if (sql === "ROLLBACK") {
                        trace.push("rollback");
                        if (pending?.item === "fail-rollback") throw new Error("rollback rejected");
                        pending = undefined;
                    }
                    else throw new Error(`Unexpected SQL: ${sql}`);
                    return { rows: [] };
                },
                release(discard: boolean) { clients--; trace.push(discard ? "discard" : "release"); },
            };
        }
    };
    let app: Awaited<ReturnType<BoringApi["createApp"]>> | undefined;
    try {
        const token = randomUUID();
        const owner = await new BoringApi().createApp<Services>(join(__dirname, "../api"), {
            env: { DATABASE_URL: "postgres://fixture/test", BORING_API_TOKEN: token },
            shutdownGraceMs: 10, shutdownTimeoutMs: 1000,
        });
        app = owner;
        const server = await owner.listen(0);
        const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
        const actor: Actor = { kind: "machine", id: "fulfillment", permissions: ["orders:read", "orders:create"] };
        const post = (item: string, authorized = true) => fetch(`${base}/orders`, {
            method: "POST", headers: { "content-type": "application/json", ...(authorized ? { authorization: `Bearer ${token}` } : {}) },
            body: JSON.stringify({ item, quantity: 2 }),
        });
        const viaHttp = await post("HTTP"); assert.equal(viaHttp.status, 201);
        const httpOrder = await viaHttp.json() as Order;
        assert.deepEqual(trace.splice(0), ["begin", "sync", "insert", "audit", "publication", "commit", "release"]);
        const controlled = await createOrder(owner, actor, { item: "controlled", quantity: 2 });
        assert.deepEqual(trace.splice(0), ["begin", "sync", "insert", "audit", "publication", "commit", "release"]);
        assert.deepEqual(await owner.execute({ identity: actor }, ctx => ctx.services.orders.get(ctx.execution, httpOrder.id)), httpOrder);
        trace.length = 0;
        assert.equal((await post("denied", false)).status, 401);
        await assert.rejects(createOrder(owner, { ...actor, permissions: [] }, { item: "denied", quantity: 1 }), { code: "forbidden" });
        const deniedHttp = await fetch(`${base}/orders`, { method: "POST", headers: {
            "content-type": "application/json", authorization: `Bearer denied:${token}`,
        }, body: JSON.stringify({ item: "denied", quantity: 1 }) });
        assert.equal(deniedHttp.status, 403);
        assert.deepEqual(trace, []);
        assert.equal((await post("fail-audit")).status, 500);
        assert.deepEqual(trace.splice(0), ["begin", "sync", "insert", "audit", "rollback", "release"]);
        await assert.rejects(createOrder(owner, actor, { item: "fail-audit", quantity: 1 }), /audit rejected/);
        assert.deepEqual(trace.splice(0), ["begin", "sync", "insert", "audit", "rollback", "release"]);
        await assert.rejects(createOrder(owner, actor, { item: "fail-rollback", quantity: 1 }), error => {
            assert.ok(error instanceof LifecycleError);
            assert.deepEqual(error.errors.map(cause => (cause as Error).message), ["audit rejected", "rollback rejected"]);
            return true;
        });
        assert.deepEqual(trace.splice(0), ["begin", "sync", "insert", "audit", "rollback", "discard"]);
        assert.equal(records.size, 2); assert.ok(records.has(controlled.id));
        const work = createOrder(owner, actor, { item: "cancel-audit", quantity: 1 });
        const rejected = assert.rejects(work, error => error instanceof ExecutionError && error.code === "cancelled");
        await auditEntered;
        const closing = owner.close();
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(closed, 0); assert.equal(clients, 1);
        releaseAudit(); await rejected; await closing;
        assert.deepEqual(trace, ["begin", "sync", "insert", "audit", "rollback", "release", "pool.close"]);
        assert.equal(records.size, 2); assert.equal(closed, 1);
    } finally {
        releaseAudit();
        if (app) await app.close();
        pg.Pool = OriginalPool;
        identityModule.createIdentity = originalIdentity;
    }
});
