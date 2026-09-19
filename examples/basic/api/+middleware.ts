import { Context } from "../../../src";

export function handler(ctx: Context) {
    const requestId = ctx.request.header("x-request-id") ?? "example-request";
    ctx.response.setHeader("x-request-id", requestId);
    return { requestId };
}
