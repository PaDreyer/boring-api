import type { Order } from "../schemas";

/** Narrow transactional effect port; the adapter stages a durable event in the current transaction. */
export interface OrderPublications {
    created(order: Order): Promise<void>;
}
