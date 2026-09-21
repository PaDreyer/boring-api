import { queuedOrder, order } from "$modules/orders/schemas";
import type { CommandHandler } from "./$types";

export const input = queuedOrder;
export const output = order;
export const timeoutMs = 30000;
export const handler: CommandHandler = ctx => ctx.services.orders.create(ctx.execution, ctx.input);
