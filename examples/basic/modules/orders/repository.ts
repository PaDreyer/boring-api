import type { Order } from "./schemas";

/** The order module's storage needs; the adapter lives in infra/. */
export interface OrderRepository {
    insert(order: Order): Promise<void>;
    find(id: string): Promise<Order | undefined>;
}
