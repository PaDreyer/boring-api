import type { MiddlewareContext } from "./$types";

export function handler(ctx: MiddlewareContext) {
    const requestId = ctx.request.header("x-request-id") ?? "example-request";
    ctx.response.setHeader("x-request-id", requestId);
    return { requestId };
}
