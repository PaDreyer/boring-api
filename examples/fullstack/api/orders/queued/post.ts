import { queuedOrder, jobReceipt } from "$modules/orders/schemas";
import type { PostHandler } from "./$types";

export const body = queuedOrder;
export const output = jobReceipt;
export const authorization = "orders:create";
export const handler: PostHandler = async ctx => {
    const receipt = await ctx.services.orders.enqueue(ctx.execution, ctx.body);
    ctx.status(202);
    return receipt;
};
