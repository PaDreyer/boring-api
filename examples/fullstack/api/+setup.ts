import type { SetupContext } from "./$types";
import { createDatabase } from "$infra/db/database";
import { createOrders } from "$modules/orders/facade";
import { createIdentity } from "$infra/identity";
import { createAccess } from "$modules/access/facade";
import { createPages } from "../web/server/pages";

export function setup(ctx: SetupContext) {
    const database = createDatabase({ connectionString: ctx.config.databaseUrl });
    ctx.onClose("PostgreSQL", () => database.close());
    const orders = createOrders(database.orders);
    return { orders, access: createAccess(createIdentity(ctx.config.token)), pages: createPages(orders) };
}
