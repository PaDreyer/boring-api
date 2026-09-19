import { Context } from "../../../src";

export async function handler(ctx: Context) {
    await Promise.resolve();
    return { data: ctx.payload };
}
