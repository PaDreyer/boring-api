import { HttpError } from "@boringapi/core";
import { requireAccess } from "$modules/access/facade";
import type { Actor } from "$modules/access/schemas";
import type { CreateOrder, Order } from "./schemas";
import type { OrderDatabase } from "./repository";
import { createOrder, getOrder, OrderNotFoundError } from "./service";

export type { OrderDatabase, OrderRepository } from "./repository";

/** Both HTTP and server pages call these operations with an explicit actor. */
export function createOrders(database: OrderDatabase) {
    return {
        async create({ input, actor }: { input: CreateOrder; actor: Actor }): Promise<Order> {
            requireAccess(actor, "orders:create");
            return database.transaction(repository => createOrder(input, actor.id, repository));
        },
        async get({ id, actor }: { id: string; actor: Actor }): Promise<Order> {
            requireAccess(actor, "orders:read");
            try { return await database.transaction(repository => getOrder(id, repository)); }
            catch (error) {
                if (error instanceof OrderNotFoundError) throw new HttpError(404, error.message);
                throw error;
            }
        },
    };
}
