import { ApplicationError, type ExecutionIdentity, type ExecutionContext } from "@boringapi/core";
import { requireAccess } from "$modules/access/facade";
import type { CreateOrder, Order, QueuedOrder } from "./schemas";
import type { OrderJobs } from "./ports/jobs";
import type { OrderDatabase } from "./ports/storage";
import { createOrder, getOrder, observeOrderCreated, OrderNotFoundError, OrderConflictError } from "./service";


/** Both HTTP and server pages call these operations with an explicit actor. */
export function createOrders(database: OrderDatabase, jobs?: OrderJobs) {
    return {
        async create(execution: ExecutionContext<ExecutionIdentity>, input: CreateOrder): Promise<Order> {
            execution.throwIfAborted();
            requireAccess(execution.identity, "orders:create");
            try { return await database.transaction(execution, transaction => createOrder(input, execution.identity.id, transaction.store, transaction.publications)); }
            catch (error) {
                if (error instanceof OrderConflictError) throw new ApplicationError("conflict", error.message);
                throw error;
            }
        },
        async enqueue(execution: ExecutionContext<ExecutionIdentity>, input: QueuedOrder) {
            execution.throwIfAborted();
            requireAccess(execution.identity, "orders:create");
            if (!jobs) throw new Error("Order jobs are not configured");
            return jobs.enqueue(execution, input);
        },
        async get(execution: ExecutionContext<ExecutionIdentity>, id: string): Promise<Order> {
            execution.throwIfAborted();
            requireAccess(execution.identity, "orders:read");
            try { return await database.transaction(execution, transaction => getOrder(id, transaction.store)); }
            catch (error) {
                if (error instanceof OrderNotFoundError) throw new ApplicationError("not_found", error.message);
                throw error;
            }
        },
        async observeCreated(execution: ExecutionContext<ExecutionIdentity>, eventId: string, input: Order): Promise<void> {
            execution.throwIfAborted();
            requireAccess(execution.identity, "orders:observe");
            await database.transaction(execution, transaction => observeOrderCreated(eventId, input, execution.identity.id, execution.correlationId, transaction.store));
        },
    };
}
