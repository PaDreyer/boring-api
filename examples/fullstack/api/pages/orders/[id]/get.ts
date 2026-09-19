import z from "zod";
import { orderParams } from "$modules/orders/schemas";
import type { GetHandler } from "./$types";

export const authorization = "orders:read";
export const params = orderParams;
export const envelope = false;
export const output = z.string();
export const handler: GetHandler = async ctx => {
    const html = await ctx.services.pages.order({ id: ctx.params.id, actor: ctx.session });
    ctx.response.type("html");
    return html;
};
