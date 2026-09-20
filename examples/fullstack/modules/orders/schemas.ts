import z from "zod";

export const createOrder = z.object({ item: z.string().trim().min(1).max(200), quantity: z.number().int().min(1).max(100), requestId: z.string().uuid().optional() });
export const queuedOrder = createOrder.extend({ requestId: z.string().uuid() });
export const jobReceipt = z.object({ id: z.string().uuid() });
export type QueuedOrder = z.infer<typeof queuedOrder>;
export const order = createOrder.omit({ requestId: true }).extend({ id: z.string().uuid() });
export const orderParams = order.pick({ id: true });
export type CreateOrder = z.infer<typeof createOrder>;
export type Order = z.infer<typeof order>;
