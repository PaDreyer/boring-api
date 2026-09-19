import type { Order } from "./schemas";

/** SQL adapters implement this port without exposing pg to business code. */
export interface OrderRepository {
    insert(order: Order): Promise<void>;
    recordCreation(order: Order, actorId: string): Promise<void>;
    find(id: string): Promise<Order | undefined>;
}

/** One repository instance is bound to one database transaction. */
export interface OrderDatabase {
    transaction<T>(operation: (repository: OrderRepository) => Promise<T>): Promise<T>;
}
