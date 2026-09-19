import type { SetupContext } from "./$types";
import { createDatabase } from "../infra/db/database";
import { databaseUrl } from "../infra/config";
import { createOrders } from "$modules/orders/facade";
import { createAccess } from "$modules/access/facade";
import { createPages } from "../web/server/pages";

export function setup(_ctx: SetupContext) {
    const database = createDatabase({ connectionString: databaseUrl() });
    const orders = createOrders(database.orders);
    return { orders, access: createAccess(process.env.BORING_API_TOKEN), pages: createPages(orders) };
}
