import { queuedOrder } from "$modules/orders/schemas";
import type { EventHandler } from "./$types";

export const payload = queuedOrder;
export const event = { type: "orders.create-requested", version: 1 } as const;
export const version = 1;
export const policy = { maxAttempts: 5, retryDelayMs: 1000, timeoutMs: 30000 } as const;
export const handler: EventHandler = async ctx => {
    await ctx.services.orders.create(ctx.execution, ctx.payload);
};
