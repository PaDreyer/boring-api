import { createOrder } from "$modules/orders/schemas";
import type { ScheduleHandler } from "./$types";

export const payload = createOrder.omit({ requestId: true });
export const input = { item: "Scheduled reference order", quantity: 1 };
export const version = 1;
// UTC hourly grid. At most the newest missed occurrence; skip while queued/running.
export const timing = { startAt: 0, everyMs: 3600000, missed: "latest", maxCatchUp: 1, overlap: "skip" } as const;
export const policy = { maxAttempts: 5, retryDelayMs: 1000, timeoutMs: 30000 } as const;
export const handler: ScheduleHandler = async ctx => {
    await ctx.services.orders.create(ctx.execution, { ...ctx.payload, requestId: ctx.occurrence.id });
};
