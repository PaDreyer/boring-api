import { Context } from "../../../../../src/core/context";

export async function handler(ctx: Context) {
    const id = ctx.request.params.id;
    ctx.set("marker", id);
    await new Promise(resolve => setTimeout(resolve, id === "first" ? 30 : 5));
    return { id: ctx.get("marker") };
}
