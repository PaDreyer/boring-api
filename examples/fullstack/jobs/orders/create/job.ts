import { queuedOrder } from "$modules/orders/schemas";
import type { JobHandler } from "./$types";

export const payload = queuedOrder;
export const version = 1;
export const policy = { maxAttempts: 5, retryDelayMs: 1000, timeoutMs: 30000 } as const;
export const handler: JobHandler = async ctx => {
    await ctx.services.orders.create(ctx.execution, ctx.payload);
};
