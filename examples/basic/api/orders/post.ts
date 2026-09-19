import { createOrder, order } from "../../modules/orders/schemas";
import type { PostHandler } from "./$types";

export const body = createOrder;
export const output = order;
export const authorization = "admin";

export const handler: PostHandler = async ctx => {
    const order = await ctx.services.orders.create({ input: ctx.body, actor: ctx.session });
    ctx.status(201);
    return order;
};
