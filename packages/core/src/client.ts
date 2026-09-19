/** Browser-safe transport. This entry point has no server or Node dependencies. */
export interface EndpointContract {
    input: object;
    output: unknown;
}

export interface RequestOptions {
    signal?: AbortSignal;
    headers?: HeadersInit;
}

export interface ClientOptions {
    fetch?: typeof fetch;
    headers?: () => HeadersInit | Promise<HeadersInit>;
    credentials?: RequestCredentials;
}

/** HTTP errors retain custom error payloads; network and abort errors propagate. */
export class ApiError extends Error {
    constructor(readonly status: number, readonly payload: unknown, message: string) {
        super(message);
        this.name = "ApiError";
    }
}

export type ApiClient<Routes extends Record<string, EndpointContract>> = {
    request<Key extends keyof Routes & string>(
        endpoint: Key,
        ...args: {} extends Routes[Key]["input"]
            ? [input?: Routes[Key]["input"], options?: RequestOptions]
            : [input: Routes[Key]["input"], options?: RequestOptions]
    ): Promise<Routes[Key]["output"]>;
};

function scalar(value: unknown): string {
    if (typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return String(value);
    throw new TypeError("URL parameters must be strings, finite numbers or booleans.");
}

export function createClient<Routes extends Record<string, EndpointContract>>(
    baseUrl = "", options: ClientOptions = {},
): ApiClient<Routes> {
    const transport = options.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
    if (/[?#]/.test(baseUrl)) throw new TypeError("The API base URL must not contain a query or fragment.");
    return {
        async request(endpoint: string, input: Record<string, unknown> = {}, request: RequestOptions = {}) {
            const match = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (\/(?:[A-Za-z0-9_:/-]*))$/.exec(endpoint);
            if (!match) throw new TypeError("Use a generated endpoint key such as GET /orders/:id.");
            const [, method, pattern] = match;
            const params = (input.params ?? {}) as Record<string, unknown>;
            const path = pattern.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name: string) => {
                if (params[name] === undefined || params[name] === null) throw new TypeError(`Missing URL parameter: ${name}`);
                const value = scalar(params[name]);
                if (!value || value === "." || value === "..") throw new TypeError(`Invalid URL parameter: ${name}`);
                return encodeURIComponent(value);
            });
            const query = new URLSearchParams();
            for (const [name, value] of Object.entries((input.query ?? {}) as Record<string, unknown>)) {
                if (value === undefined) continue;
                if (Array.isArray(value)) {
                    if (!value.length) throw new TypeError("Query arrays must contain at least one value; omit an optional field explicitly instead.");
                    for (const item of value) query.append(`${name}[]`, scalar(item));
                } else query.append(name, scalar(value));
            }
            const headers = new Headers(await options.headers?.());
            new Headers(request.headers).forEach((value, name) => headers.set(name, value));
            headers.set("Accept", "application/json");
            let body: string | undefined;
            if (input.body !== undefined) {
                if (method === "GET" || method === "HEAD") throw new TypeError(`${method} requests cannot contain a body.`);
                body = JSON.stringify(input.body);
                headers.set("Content-Type", "application/json");
            }
            const suffix = query.toString();
            const response = await transport(`${baseUrl.replace(/\/$/, "")}${path}${suffix ? `?${suffix}` : ""}`, {
                method, headers, body, signal: request.signal, credentials: options.credentials ?? "same-origin",
            });
            const text = method === "HEAD" || response.status === 204 ? "" : await response.text();
            let payload: unknown;
            const mediaType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
            if (method !== "HEAD" && response.status !== 204 && mediaType?.startsWith("text/")) payload = text;
            else if (text) {
                try { payload = JSON.parse(text); }
                catch {
                    if (response.ok) throw new ApiError(response.status, text, "Expected a JSON API response.");
                    payload = text;
                }
            }
            if (!response.ok) {
                const error = payload && typeof payload === "object" && "error" in payload ? payload.error : undefined;
                const message = error && typeof error === "object" && "message" in error && typeof error.message === "string"
                    ? error.message : `HTTP ${response.status}`;
                throw new ApiError(response.status, payload, message);
            }
            return payload;
        },
    } as ApiClient<Routes>;
}
