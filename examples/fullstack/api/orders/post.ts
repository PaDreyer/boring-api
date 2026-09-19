import { createOrder, order } from "$modules/orders/schemas";
import type { PostHandler } from "./$types";

export const authorization = "orders:create";
export const body = createOrder;
export const output = order;
export const handler: PostHandler = async ctx => {
    const result = await ctx.services.orders.create({ input: ctx.body, actor: ctx.session });
    ctx.status(201);
    return result;
};
