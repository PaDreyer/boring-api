import { Context } from "../../../src";

export function handler(ctx: Context) {
    return { data: ctx.payload };
}
