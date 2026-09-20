import { order, orderParams } from "$modules/orders/schemas";
import type { GetHandler } from "./$types";

export const authorization = "orders:read";
export const params = orderParams;
export const output = order;
export const handler: GetHandler = ctx => ctx.services.orders.get(ctx.execution, ctx.params.id);
