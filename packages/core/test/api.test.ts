import assert from "node:assert/strict";
import { createServer, IncomingHttpHeaders, request as httpRequest, Server } from "node:http";
import { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { BoringApi } from "../src";

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
        const server = createServer(app.http).listen(0, "127.0.0.1", () => resolve(server));
        server.once("error", reject);
    });
}

async function close(server: Server) {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

describe("permission authorization", () => {
    let server: Server;
    before(async () => { server = await listen(join(__dirname, "fixtures", "permissions")); });
    after(async () => { if (server) await close(server); });

    it("requires a session and enforces each rule before the handler", async () => {
        const cases = [
            { method: "GET", path: "/orders", reader: 200, creator: 403 },
            { method: "POST", path: "/orders", reader: 403, creator: 200 },
            { method: "GET", path: "/all", reader: 403, creator: 403 },
            { method: "GET", path: "/any", reader: 200, creator: 200 },
        ];
        for (const route of cases) {
            assert.equal((await request(server, route.method, route.path)).status, 401);
            for (const [identity, status] of [
                ["reader", route.reader], ["creator", route.creator], ["both", 200], ["neither", 403],
            ] as const) {
                const response = await request(server, route.method, route.path, undefined, { authorization: identity });
                assert.equal(response.status, status, `${identity}: ${route.method} ${route.path}`);
                if (status === 403) assert.deepEqual(response.body, { error: { message: "Forbidden" } });
            }
        }
    });

    it("keeps concurrent permission grants isolated", async () => {
        const responses = await Promise.all(["reader", "creator", "both", "neither"].map(identity =>
            request(server, "GET", "/orders", undefined, { authorization: identity })));
        assert.deepEqual(responses.map(response => response.status), [200, 403, 200, 403]);
    });

    it("preserves unexpected authorization errors as server errors", async () => {
        const response = await request(server, "GET", "/orders", undefined, { authorization: "failure" });
        assert.equal(response.status, 500);
        assert.deepEqual(response.body, { error: { message: "Internal Server Error" } });
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
    const fs = require("node:fs");
    const read = fs.readdirSync;
    try {
        mkdirSync(join(root, "Foo"));
        writeFileSync(join(root, "Foo/get.js"), "exports.handler = () => ({ ok: true });\n");
        try {
            mkdirSync(join(root, "foo"));
            writeFileSync(join(root, "foo/get.js"), "exports.handler = () => ({ ok: true });\n");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            // Case-insensitive volumes cannot represent this invalid tree. Supply
            // its second directory entry while both spellings resolve to the fixture.
            fs.readdirSync = (path: string, options: unknown) => {
                const entries = read(path, options);
                return path === root ? [...entries, { name: "foo", isDirectory: () => true, isFile: () => false }] : entries;
            };
        }
        await assert.rejects(() => new BoringApi().createApp(root), /Duplicate route/);
    } finally {
        fs.readdirSync = read;
        rmSync(root, { recursive: true, force: true });
    }
});

it("keeps explicit HEAD routes and nearest generic/500 error fallbacks after shared discovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "boring-api-discovery-"));
    try {
        mkdirSync(join(root, "scoped", "child"), { recursive: true });
        writeFileSync(join(root, "get.js"), 'exports.handler = ctx => { ctx.response.setHeader("x-handler", "get"); return null; };');
        writeFileSync(join(root, "head.js"), 'exports.handler = ctx => { ctx.response.setHeader("x-handler", "head"); return null; };');
        writeFileSync(join(root, "+error.503.js"), 'exports.handler = () => ({ template: "root503" });');
        writeFileSync(join(root, "scoped/+error.js"), 'exports.handler = () => ({ template: "scoped" });');
        writeFileSync(join(root, "scoped/child/+error.500.js"), 'exports.handler = () => ({ template: "child500" });');
        const errorModule = JSON.stringify(require.resolve("../src/core/errors"));
        const failure = `const { HttpError } = require(${errorModule}); exports.handler = () => { throw new HttpError(503, "Unavailable"); };`;
        writeFileSync(join(root, "scoped/get.js"), failure);
        writeFileSync(join(root, "scoped/child/get.js"), failure);
        const server = await listen(root);
        try {
            assert.equal((await request(server, "HEAD", "/")).headers["x-handler"], "head");
            assert.equal((await request(server, "GET", "/")).headers["x-handler"], "get");
            assert.deepEqual((await request(server, "GET", "/scoped")).body, { template: "scoped" });
            assert.deepEqual((await request(server, "GET", "/scoped/child")).body, { template: "child500" });
        } finally { await close(server); }
    } finally { rmSync(root, { recursive: true, force: true }); }
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

it("rejects falsey sessions that do not establish an execution identity", async () => {
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
            assert.equal(response.status, 500);
            assert.deepEqual(response.body, { error: { message: "Internal Server Error" } });
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
            "exports.authenticate = ctx => { ctx.set('session', { kind: 'user', id: 'viewer', permissions: [], role: 'viewer' }); };\n");
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
