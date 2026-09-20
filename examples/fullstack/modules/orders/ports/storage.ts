import type { ExecutionContext } from "@boringapi/core";
import type { Order } from "../schemas";

/** SQL adapters implement this port without exposing pg to business code. */
export interface OrderStore {
    newId(): string;
    insert(order: Order): Promise<void>;
    recordCreation(order: Order, actorId: string): Promise<void>;
    find(id: string): Promise<Order | undefined>;
}

/** One store instance is bound to one database transaction. */
export interface OrderDatabase {
    transaction<T>(execution: ExecutionContext, operation: (store: OrderStore) => Promise<T>): Promise<T>;
}
