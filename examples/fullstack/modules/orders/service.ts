import { randomUUID } from "node:crypto";
import { createOrder as createOrderSchema, orderParams } from "./schemas";
import type { CreateOrder, Order } from "./schemas";
import type { OrderRepository } from "./repository";

/** Private order rules and persistence operations, independent of HTTP and pg. */
export class OrderNotFoundError extends Error {
    constructor() { super("Order not found"); }
}

export async function createOrder(input: CreateOrder, actorId: string, repository: OrderRepository): Promise<Order> {
    const data = createOrderSchema.parse(input);
    const order = { ...data, id: randomUUID() };
    await repository.insert(order);
    await repository.recordCreation(order, actorId);
    return order;
}

export async function getOrder(id: string, repository: OrderRepository): Promise<Order> {
    orderParams.parse({ id });
    const order = await repository.find(id);
    if (!order) throw new OrderNotFoundError();
    return order;
}
