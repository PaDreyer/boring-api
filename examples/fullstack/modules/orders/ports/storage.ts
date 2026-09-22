import type { ExecutionContext } from "@boringapi/core";
import type { Order } from "../schemas";
import type { OrderPublications } from "./publications";

/** SQL adapters implement this port without exposing pg to business code. */
export interface OrderStore {
    newId(): string;
    reserve(requestId: string): Promise<Order | undefined>;
    remember(requestId: string, order: Order): Promise<void>;
    insert(order: Order): Promise<void>;
    recordCreation(order: Order, actorId: string): Promise<void>;
    find(id: string): Promise<Order | undefined>;
    observeCreated(eventId: string, order: Order, actorId: string, correlationId: string): Promise<void>;
}

/** One store instance is bound to one database transaction. */
export interface OrderDatabase {
    transaction<T>(execution: ExecutionContext, operation: (transaction: { readonly store: OrderStore; readonly publications: OrderPublications }) => Promise<T>): Promise<T>;
}
