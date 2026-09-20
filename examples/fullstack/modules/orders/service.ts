import { createOrder as createOrderSchema, orderParams } from "./schemas";
import type { CreateOrder, Order } from "./schemas";
import type { OrderStore } from "./ports/storage";

/** Private order rules and persistence operations, independent of HTTP and pg. */
export class OrderNotFoundError extends Error {
    constructor() { super("Order not found"); }
}

export async function createOrder(input: CreateOrder, actorId: string, store: OrderStore): Promise<Order> {
    const data = createOrderSchema.parse(input);
    const order = { ...data, id: store.newId() };
    await store.insert(order);
    await store.recordCreation(order, actorId);
    return order;
}

export async function getOrder(id: string, store: OrderStore): Promise<Order> {
    orderParams.parse({ id });
    const order = await store.find(id);
    if (!order) throw new OrderNotFoundError();
    return order;
}
