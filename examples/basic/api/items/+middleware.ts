import type { MiddlewareContext } from "./$types";

export function handler(ctx: MiddlewareContext) {
    ctx.response.setHeader("x-section", "items");
    return { section: "items" as const };
}
