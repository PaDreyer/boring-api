import assert from "node:assert/strict";
import { createServer, IncomingHttpHeaders, request as httpRequest, Server } from "node:http";
import { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { BoringApi } from "../src";
import type { Order } from "../examples/basic/modules/orders/schemas";

// Keep lifecycle imports compatible with the minimum supported Node 18 declarations.
const { before, after } = require("node:test");

type Result = { status: number; body: unknown; text: string; headers: IncomingHttpHeaders };

async function request(server: Server, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Result> {
    const port = (server.address() as AddressInfo).port;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const req = httpRequest({ hostname: "127.0.0.1", port, method, path,
            headers: { ...(payload === undefined ? {} : { "content-type": "application/json" }), ...headers } },
        (res: import("node:http").IncomingMessage) => {
            const chunks: Buffer[] = [];
            res.on("data", chunk => chunks.push(Buffer.from(chunk)));
            res.on("end", () => {
                const text = Buffer.concat(chunks).toString("utf8");
                let parsed: unknown = text;
                try { parsed = JSON.parse(text); } catch { /* empty or non-JSON response */ }
                resolve({ status: res.statusCode ?? 0, body: parsed, text, headers: res.headers });
            });
        });
        req.on("error", reject);
        req.end(payload);
    });
}

async function listen(endpoints: string): Promise<Server> {
    const app = await new BoringApi().createApp(endpoints);
    return new Promise((resolve, reject) => {
        const server = createServer(app).listen(0, "127.0.0.1", () => resolve(server));
        server.once("error", reject);
    });
}

async function close(server: Server) {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

describe("example API", () => {
    let server: Server;
    const token = randomUUID();
    const authorized = { authorization: `Bearer ${token}` };
    const previousToken = process.env.BORING_API_TOKEN;
    before(async () => {
        process.env.BORING_API_TOKEN = token;
        server = await listen(join(__dirname, "..", "examples", "basic", "api"));
    });
    after(async () => {
        try { if (server) await close(server); }
        finally {
            if (previousToken === undefined) delete process.env.BORING_API_TOKEN;
            else process.env.BORING_API_TOKEN = previousToken;
        }
    });

    it("maps folders and method files to routes, with static paths first", async () => {
        const health = await request(server, "GET", "/health");
        assert.equal(health.status, 200);
        assert.deepEqual(health.body, { service: "boring-api", status: "ok" });
        assert.equal(health.headers["x-request-id"], "example-request");
        assert.equal(health.headers["x-section"], undefined);
        const item = await request(server, "GET", "/items/42", undefined, { "x-request-id": "item-42" });
        assert.deepEqual(item.body, { id: "42" });
        assert.equal(item.headers["x-request-id"], "item-42");
        assert.equal(item.headers["x-section"], "items");
        assert.deepEqual((await request(server, "GET", "/items/latest")).body, { id: "latest", source: "static" });
        const missing = await request(server, "GET", "/missing");
        assert.equal(missing.status, 404);
        assert.deepEqual(missing.body, { error: { message: "Route not found" } });
    });

    it("parses JSON, validates input, validates output and applies the global envelope", async () => {
        const success = await request(server, "POST", "/echo", { message: "hello" });
        assert.equal(success.status, 200);
        assert.deepEqual(success.body, { data: { message: "hello" } });
        const invalid = await request(server, "POST", "/echo", { message: "" });
        assert.equal(invalid.status, 400);
        assert.equal((invalid.body as any).error.message, "Invalid body");
        assert.equal((await request(server, "GET", "/items/%24")).status, 400);
        assert.equal((await request(server, "GET", "/items/42?detail=wrong")).status, 400);
        assert.deepEqual((await request(server, "GET", "/items/42?detail=full")).body,
            { id: "42", detail: "full" });
    });

    it("denies a protected route without a session", async () => {
        assert.equal((await request(server, "GET", "/secure")).status, 401);
    });

    it("creates and retrieves orders through the shared facade and schemas", async () => {
        const created = await request(server, "POST", "/orders",
            { item: " Notebook ", quantity: 2 }, authorized);
        assert.equal(created.status, 201);
        const order = (created.body as { data: Order }).data;
        assert.equal(order.item, "Notebook");
        assert.equal(order.quantity, 2);
        assert.equal(typeof order.id, "string");

        const found = await request(server, "GET", `/orders/${order.id}`, undefined, authorized);
        assert.equal(found.status, 200);
        assert.deepEqual(found.body, created.body);
    });

    it("validates order requests and distinguishes missing orders from unknown routes", async () => {
        const missing = await request(server, "GET", `/orders/${randomUUID()}`, undefined, authorized);
        assert.equal(missing.status, 404);
        assert.deepEqual(missing.body, { error: { message: "Order not found" } });
        const invalid = await request(server, "POST", "/orders",
            { item: "Notebook", quantity: 0 }, authorized);
        assert.equal(invalid.status, 400);
        assert.equal((await request(server, "GET", "/orders/not-a-uuid", undefined, authorized)).status, 400);
    });

    it("requires authentication for both order operations", async () => {
        assert.equal((await request(server, "POST", "/orders", { item: "Notebook", quantity: 1 })).status, 401);
        assert.equal((await request(server, "GET", `/orders/${randomUUID()}`)).status, 401);
        assert.equal((await request(server, "GET", `/orders/${randomUUID()}`, undefined,
            { authorization: `Bearer ${randomUUID()}` })).status, 401);
    });

    it("creates independent order storage for each application instance", async () => {
        const created = await request(server, "POST", "/orders",
            { item: "Notebook", quantity: 1 }, authorized);
        assert.equal(created.status, 201);
        const order = (created.body as { data: Order }).data;
        const other = await listen(join(__dirname, "..", "examples", "basic", "api"));
        try {
            assert.equal((await request(other, "GET", `/orders/${order.id}`, undefined, authorized)).status, 404);
            assert.equal((await request(server, "GET", `/orders/${order.id}`, undefined, authorized)).status, 200);
        } finally {
            await close(other);
        }
    });
});

describe("async hooks and request isolation", () => {
    let server: Server;
    before(async () => { server = await listen(join(__dirname, "fixtures", "endpoints")); });
    after(async () => { await close(server); });

    it("awaits auth, authorization, handler and envelope", async () => {
        const response = await request(server, "GET", "/secure", undefined, { authorization: "Bearer test" });
        assert.equal(response.status, 200);
        assert.deepEqual(response.body, { data: { ok: true } });
        assert.equal((await request(server, "GET", "/secure")).status, 401);
        assert.equal((await request(server, "GET", "/secure", undefined,
            { authorization: "Bearer viewer" })).status, 403);
    });

    it("keeps concurrent request contexts separate", async () => {
        const [first, second] = await Promise.all([
            request(server, "GET", "/slow/first"),
            request(server, "GET", "/slow/second"),
        ]);
        assert.deepEqual(first.body, { data: { id: "first" } });
        assert.deepEqual(second.body, { data: { id: "second" } });
    });

    it("inherits middleware and uses the nearest envelope and error template", async () => {
        const success = await request(server, "GET", "/scoped");
        assert.deepEqual(success.body, { scoped: { ok: true } });
        const failure = await request(server, "GET", "/scoped/fail");
        assert.equal(failure.status, 500);
        assert.deepEqual(failure.body,
            { error: { message: "Scoped failure" }, marker: "from-middleware" });
    });

    it("does not expose handler errors or invalid output", async () => {
        for (const path of ["/fail", "/invalid-output"]) {
            const response = await request(server, "GET", path);
            assert.equal(response.status, 500);
            assert.deepEqual(response.body, { error: { message: "Internal Server Error" } });
            assert.ok(!response.text.includes("private failure detail"));
        }
    });
});

it("rejects ambiguous dynamic routes at startup", async () => {
    const root = mkdtempSync(join(tmpdir(), "boring-api-test-"));
    try {
        for (const name of ["[id]", "[slug]"]) {
            mkdirSync(join(root, name));
            writeFileSync(join(root, name, "get.js"), "exports.handler = () => ({ ok: true });\n");
        }
        await assert.rejects(() => new BoringApi().createApp(root), /Duplicate route/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

it("rejects routes that differ only by case", async () => {
    const root = mkdtempSync(join(tmpdir(), "boring-api-case-"));
    try {
        for (const name of ["Foo", "foo"]) {
            mkdirSync(join(root, name));
            writeFileSync(join(root, name, "get.js"), "exports.handler = () => ({ ok: true });\n");
        }
        await assert.rejects(() => new BoringApi().createApp(root), /Duplicate route/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

it("clears a route payload before an error template handles a failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "boring-api-error-payload-"));
    try {
        writeFileSync(join(root, "+error.500.js"), "exports.handler = () => undefined;\n");
        writeFileSync(join(root, "get.js"), [
            "exports.output = { parse() { throw new Error('invalid private output'); } };",
            "exports.handler = () => ({ secret: 'LEAKED' });",
            "",
        ].join("\n"));
        const server = await listen(root);
        try {
            const response = await request(server, "GET", "/");
            assert.equal(response.status, 500);
            assert.deepEqual(response.body, { error: { message: "Internal Server Error" } });
            assert.ok(!response.text.includes("LEAKED"));
        } finally {
            await close(server);
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

it("accepts falsey non-null sessions consistently with generated types", async () => {
    const root = mkdtempSync(join(tmpdir(), "boring-api-falsey-session-"));
    try {
        mkdirSync(join(root, "protected"));
        writeFileSync(join(root, "+auth.js"), "exports.authenticate = () => false;\n");
        writeFileSync(join(root, "protected", "get.js"), [
            "exports.authentication = true;",
            "exports.handler = ctx => ({ session: ctx.session });",
            "",
        ].join("\n"));
        const server = await listen(root);
        try {
            const response = await request(server, "GET", "/protected");
            assert.equal(response.status, 200);
            assert.deepEqual(response.body, { session: false });
        } finally {
            await close(server);
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

it("uses safe defaults until convention files override them", async () => {
    const root = mkdtempSync(join(tmpdir(), "boring-api-defaults-"));
    try {
        for (const name of ["public", "protected", "restricted"]) mkdirSync(join(root, name));
        writeFileSync(join(root, "public", "get.js"), "exports.handler = () => ({ ok: true });\n");
        writeFileSync(join(root, "protected", "get.js"),
            "exports.authentication = true; exports.handler = () => ({ ok: true });\n");
        writeFileSync(join(root, "restricted", "get.js"),
            "exports.authorization = 'admin'; exports.handler = () => ({ ok: true });\n");

        const defaults = await listen(root);
        try {
            assert.deepEqual((await request(defaults, "GET", "/public")).body, { ok: true });
            assert.equal((await request(defaults, "GET", "/protected")).status, 401);
            assert.equal((await request(defaults, "GET", "/restricted")).status, 401);
        } finally {
            await close(defaults);
        }

        writeFileSync(join(root, "+auth.js"),
            "exports.authenticate = ctx => { ctx.set('session', { role: 'viewer' }); };\n");
        const overridden = await listen(root);
        try {
            assert.deepEqual((await request(overridden, "GET", "/protected")).body, { ok: true });
            assert.equal((await request(overridden, "GET", "/restricted")).status, 403);
        } finally {
            await close(overridden);
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
