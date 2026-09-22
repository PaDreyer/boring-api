import { createOrder as createOrderSchema, order, orderParams } from "./schemas";
import type { CreateOrder, Order } from "./schemas";
import type { OrderStore } from "./ports/storage";
import type { OrderPublications } from "./ports/publications";

/** Private order rules and persistence operations, independent of HTTP and pg. */
export class OrderNotFoundError extends Error {
    constructor() { super("Order not found"); }
}

export class OrderConflictError extends Error { constructor() { super("Idempotency key was used with different order data"); } }

export async function createOrder(input: CreateOrder, actorId: string, store: OrderStore, publications: OrderPublications): Promise<Order> {
    const data = createOrderSchema.parse(input);
    if (data.requestId) {
        const prior = await store.reserve(data.requestId);
        if (prior) {
            if (prior.item !== data.item || prior.quantity !== data.quantity) throw new OrderConflictError();
            return prior;
        }
    }
    const order = { item: data.item, quantity: data.quantity, id: store.newId() };
    await store.insert(order);
    await store.recordCreation(order, actorId);
    if (data.requestId) await store.remember(data.requestId, order);
    await publications.created(order);
    return order;
}

export async function observeOrderCreated(eventId: string, input: Order, actorId: string, correlationId: string, store: OrderStore): Promise<void> {
    const value = order.parse(input);
    await store.observeCreated(eventId, value, actorId, correlationId);
}

export async function getOrder(id: string, store: OrderStore): Promise<Order> {
    orderParams.parse({ id });
    const order = await store.find(id);
    if (!order) throw new OrderNotFoundError();
    return order;
}
