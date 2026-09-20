import { ApplicationError, type ExecutionContext } from "@boringapi/core";
import { requireAccess } from "$modules/access/facade";
import type { Actor } from "$modules/access/schemas";
import type { CreateOrder, Order } from "./schemas";
import type { OrderDatabase } from "./ports/storage";
import { createOrder, getOrder, OrderNotFoundError } from "./service";


/** Both HTTP and server pages call these operations with an explicit actor. */
export function createOrders(database: OrderDatabase) {
    return {
        async create(execution: ExecutionContext<Actor>, input: CreateOrder): Promise<Order> {
            execution.throwIfAborted();
            requireAccess(execution.identity, "orders:create");
            return database.transaction(execution, store => createOrder(input, execution.identity.id, store));
        },
        async get(execution: ExecutionContext<Actor>, id: string): Promise<Order> {
            execution.throwIfAborted();
            requireAccess(execution.identity, "orders:read");
            try { return await database.transaction(execution, store => getOrder(id, store)); }
            catch (error) {
                if (error instanceof OrderNotFoundError) throw new ApplicationError("not_found", error.message);
                throw error;
            }
        },
    };
}
