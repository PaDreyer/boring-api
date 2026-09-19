import { randomUUID } from "crypto";
import { HttpError } from "@boringapi/core";
import { requireAccess } from "$modules/access/facade";
import type { Actor } from "$modules/access/schemas";
import type { CreateOrder, Order } from "./schemas";

export interface OrderStore {
    insert(order: Order): Promise<void>;
    find(id: string): Promise<Order | undefined>;
}

export type OrderActor = Actor;

/** Public order operations. Dependencies live for the app; actors belong to each call. */
export function createOrders(store: OrderStore) {
    return {
        async create({ input, actor }: { input: CreateOrder; actor: OrderActor }): Promise<Order> {
            requireAccess(actor, "orders:create");
            const order: Order = { id: randomUUID(), item: input.item, quantity: input.quantity };
            await store.insert(order);
            return order;
        },

        async get({ id, actor }: { id: string; actor: OrderActor }): Promise<Order> {
            requireAccess(actor, "orders:read");
            const order = await store.find(id);
            if (!order) throw new HttpError(404, "Order not found");
            return order;
        },
    };
}
