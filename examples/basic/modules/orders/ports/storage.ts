import type { Order } from "../schemas";

/** The order module's storage needs; the adapter lives in infra/. */
export interface OrderStore {
    newId(): string;
    insert(order: Order): Promise<void>;
    find(id: string): Promise<Order | undefined>;
}
