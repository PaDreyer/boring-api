import type { SetupContext } from "./$types";
import { createDatabase } from "$infra/db/database";
import { createOrders } from "$modules/orders/facade";
import { createIdentity } from "$infra/identity";
import { createAccess } from "$modules/access/facade";
import { createPages } from "../web/server/pages";

export function setup(ctx: SetupContext) {
    const database = createDatabase({ connectionString: ctx.config.databaseUrl });
    ctx.onClose("PostgreSQL", () => database.close());
    const jobs = ctx.jobs(database.jobs, { identity: { kind: "machine", id: "order-worker", permissions: ctx.config.workerPermissions } });
    const orders = createOrders(database.orders, jobs.for("orders/create"));
    return { orders, access: createAccess(createIdentity(ctx.config.token)), pages: createPages(orders) };
}
