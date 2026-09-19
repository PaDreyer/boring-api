import { Context } from "../../../../src";

export function handler(ctx: Context) {
    return { scoped: ctx.payload };
}
