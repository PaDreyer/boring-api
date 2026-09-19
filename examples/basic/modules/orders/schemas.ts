import z from "zod";

export const createOrder = z.object({
    item: z.string().trim().min(1),
    quantity: z.number().int().min(1).max(100),
});

export const order = createOrder.extend({ id: z.string().uuid() });
export const orderParams = order.pick({ id: true });

export type CreateOrder = z.infer<typeof createOrder>;
export type Order = z.infer<typeof order>;
