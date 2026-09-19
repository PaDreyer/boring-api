import assert from "node:assert/strict";
import { it } from "node:test";
import { ApiError, createClient } from "../src/client";

type Routes = {
    "GET /orders/:id": { input: { params: { id: string }; query?: { tag?: string[]; limit?: number; active?: boolean } }; output: { id: string } };
    "POST /orders": { input: { body: { item: string; quantity: number } }; output: { id: string } };
    "GET /health": { input: {}; output: { status: string } };
    "DELETE /orders/:id": { input: { params: { id: string } }; output: undefined };
    "HEAD /health": { input: {}; output: undefined };
};

it("uses one JSON transport with encoded URLs, request-local headers and cancellation", async () => {
    let authorization = "first";
    const calls: { url: string; init: RequestInit }[] = [];
    const api = createClient<Routes>("https://example.test/api/", {
        headers: async () => ({ Authorization: authorization }),
        fetch: async (url, init) => {
            calls.push({ url: String(url), init: init! });
            return new Response(JSON.stringify({ id: "order" }), { status: 200, headers: { "Content-Type": "application/json" } });
        },
    });
    const controller = new AbortController();
    assert.deepEqual(await api.request("GET /orders/:id", {
        params: { id: "a/b ?#" }, query: { tag: ["x&y", "z"], limit: 2, active: false },
    }, { signal: controller.signal }), { id: "order" });
    assert.equal(calls[0].url, "https://example.test/api/orders/a%2Fb%20%3F%23?tag%5B%5D=x%26y&tag%5B%5D=z&limit=2&active=false");
    assert.equal(calls[0].init.signal, controller.signal);
    assert.equal(calls[0].init.credentials, "same-origin");
    authorization = "second";
    await api.request("POST /orders", { body: { item: "Book", quantity: 2 } });
    assert.equal(new Headers(calls[0].init.headers).get("Authorization"), "first");
    assert.equal(new Headers(calls[1].init.headers).get("Authorization"), "second");
    assert.equal(new Headers(calls[1].init.headers).get("Content-Type"), "application/json");
    assert.equal(calls[1].init.body, '{"item":"Book","quantity":2}');
});

it("retains error payloads, handles empty responses and propagates network failures", async () => {
    const response = (value: Response) => createClient<Routes>("/api", { fetch: async () => value });
    const payload = { error: { message: "Invalid body", details: [{ path: ["item"] }] } };
    await assert.rejects(response(new Response(JSON.stringify(payload), { status: 400, headers: { "Content-Type": "application/json" } })).request("GET /health"),
        error => error instanceof ApiError && error.status === 400 && error.message === "Invalid body" && assert.deepEqual(error.payload, payload) === undefined);
    await assert.rejects(response(new Response("Bad gateway", { status: 502 })).request("GET /health"),
        error => error instanceof ApiError && error.status === 502 && error.payload === "Bad gateway");
    await assert.rejects(response(new Response("<html>not an API</html>", { headers: { "Content-Type": "application/json" } })).request("GET /health"), /Expected a JSON API response/);
    assert.equal(await response(new Response(null, { status: 204 })).request("DELETE /orders/:id", { params: { id: "1" } }), undefined);
    assert.equal(await response(new Response(null)).request("HEAD /health"), undefined);
    const failure = new Error("network failed");
    await assert.rejects(createClient<Routes>("", { fetch: async () => { throw failure; } }).request("GET /health"), error => error === failure);
});

it("rejects malformed input before fetching and exposes checked endpoint signatures", async () => {
    const api = createClient<Routes>("", { fetch: async () => { throw new Error("must not fetch"); } });
    assert.throws(() => createClient("/api?x=1"), /query or fragment/);
    for (const id of ["", ".", ".."]) await assert.rejects(api.request("GET /orders/:id", { params: { id } }), /Invalid URL parameter/);
    await assert.rejects(api.request("GET /orders/:id", { params: { id: "1" }, query: { tag: [] } }), /at least one value/);
    // @ts-expect-error Generated clients require URL parameters.
    await assert.rejects(api.request("GET /orders/:id"), /Missing URL parameter/);
    // @ts-expect-error Endpoint keys are inferred from route contracts.
    await assert.rejects(api.request("not a route"), /generated endpoint key/);
    // @ts-expect-error Query values must match the schema's input types.
    await assert.rejects(api.request("GET /orders/:id", { params: { id: "1" }, query: { limit: {} } }), /URL parameters/);
    if (false) {
        // @ts-expect-error Body values must match the schema's input types.
        api.request("POST /orders", { body: { item: "Book", quantity: "two" } });
        // @ts-expect-error A body is required for this operation.
        api.request("POST /orders");
    }
});

it("decodes by media type, including parameters, structured JSON and text error bodies", async () => {
    const api = (text: string, contentType: string, status = 200) => createClient<Routes>("", {
        fetch: async () => new Response(text, { status, headers: { "Content-Type": contentType } }),
    });
    for (const text of ["hello", "123", '{"id":"text"}', ""]) {
        assert.equal(await api(text, "Text/Plain; charset=utf-8").request("GET /health"), text);
    }
    assert.equal(await api("<p>hello</p>", "text/html; charset=utf-8").request("GET /health"), "<p>hello</p>");
    for (const contentType of ["application/json; charset=utf-8", "application/vnd.boring+json"]) {
        assert.deepEqual(await api('{"status":"ok"}', contentType).request("GET /health"), { status: "ok" });
    }
    const problem = { error: { message: "Invalid request" }, detail: "preserved" };
    await assert.rejects(api(JSON.stringify(problem), "application/problem+json; charset=utf-8", 400).request("GET /health"),
        error => error instanceof ApiError && error.message === "Invalid request" && assert.deepEqual(error.payload, problem) === undefined);
    await assert.rejects(api("123", "text/plain", 500).request("GET /health"),
        error => error instanceof ApiError && error.status === 500 && error.payload === "123");
});
