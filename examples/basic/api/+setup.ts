import type { SetupContext } from "./$types";
import { createMemoryStore } from "$infra/memoryStore";
import { createOrders } from "$modules/orders/facade";
import type { Order } from "$modules/orders/schemas";

export function setup(ctx: SetupContext) {
    ctx.logger.info("Preparing example services");
    const orderStore = createMemoryStore<Order>();
    return {
        serviceName: "boring-api",
        orders: createOrders(orderStore),
    };
}
