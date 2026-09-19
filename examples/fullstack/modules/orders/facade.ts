import { randomUUID } from "node:crypto";
import { HttpError } from "@boringapi/core";
import { requireAccess } from "$modules/access/facade";
import type { Actor } from "$modules/access/schemas";
import { createOrder, orderParams } from "./schemas";
import type { CreateOrder, Order } from "./schemas";

export interface OrderStore {
    insert(order: Order): Promise<void>;
    recordCreation(order: Order, actorId: string): Promise<void>;
    find(id: string): Promise<Order | undefined>;
}

export interface OrderDatabase {
    transaction<T>(operation: (store: OrderStore) => Promise<T>): Promise<T>;
}

/** Both HTTP and server pages call these operations with an explicit actor. */
export function createOrders(database: OrderDatabase) {
    return {
        async create({ input, actor }: { input: CreateOrder; actor: Actor }): Promise<Order> {
            requireAccess(actor, "orders:create");
            const data = createOrder.parse(input);
            const order = { ...data, id: randomUUID() };
            // The business operation owns the atomic boundary, including its audit event.
            return database.transaction(async store => {
                await store.insert(order);
                await store.recordCreation(order, actor.id);
                return order;
            });
        },
        async get({ id, actor }: { id: string; actor: Actor }): Promise<Order> {
            requireAccess(actor, "orders:read");
            orderParams.parse({ id });
            return database.transaction(async store => {
                const order = await store.find(id);
                if (!order) throw new HttpError(404, "Order not found");
                return order;
            });
        },
    };
}
