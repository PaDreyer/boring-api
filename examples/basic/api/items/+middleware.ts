import { Context } from "../../../../src";

export function handler(ctx: Context) {
    ctx.response.setHeader("x-section", "items");
    return { section: "items" as const };
}
