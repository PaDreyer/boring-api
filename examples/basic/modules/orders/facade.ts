import { ApplicationError } from "@boringapi/core";
import { requireAccess } from "$modules/access/facade";
import type { Actor } from "$modules/access/schemas";
import type { CreateOrder, Order } from "./schemas";
import type { OrderStore } from "./ports/storage";
import { createOrder, getOrder, OrderNotFoundError } from "./service";


export type OrderActor = Actor;

/** Public order operations. Dependencies live for the app; actors belong to each call. */
export function createOrders(store: OrderStore) {
    return {
        async create({ input, actor }: { input: CreateOrder; actor: OrderActor }): Promise<Order> {
            requireAccess(actor, "orders:create");
            return createOrder(input, store);
        },

        async get({ id, actor }: { id: string; actor: OrderActor }): Promise<Order> {
            requireAccess(actor, "orders:read");
            try { return await getOrder(id, store); }
            catch (error) {
                if (error instanceof OrderNotFoundError) throw new ApplicationError("not_found", error.message);
                throw error;
            }
        },
    };
}
