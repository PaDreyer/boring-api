import type { SetupContext } from "./$types";
import { createDatabase } from "$infra/db/database";
import { createOrders } from "$modules/orders/facade";
import { createIdentity } from "$infra/identity";
import { createAccess } from "$modules/access/facade";
import { createPages } from "../web/server/pages";
import { createOperations } from "$infra/operations";

export function setup(ctx: SetupContext) {
    const database = createDatabase({ connectionString: ctx.config.databaseUrl });
    ctx.onClose("PostgreSQL", () => database.close());
    ctx.observability(createOperations());
    ctx.readiness("PostgreSQL", () => database.ready(), { timeoutMs: 1000 });
    const jobs = ctx.jobs(database.jobs, { identity: { kind: "machine", id: "order-worker", permissions: ctx.config.workerPermissions } });
    ctx.schedules(database.jobs, { identity: { kind: "machine", id: "order-scheduler", permissions: ctx.config.schedulePermissions } });
    ctx.events(database.jobs, { identity: { kind: "machine", id: "order-consumer", permissions: ctx.config.eventPermissions } });
    ctx.publications(database.jobs, { identity: { kind: "machine", id: "order-publisher", permissions: ctx.config.publisherPermissions } });
    ctx.commands({ identity: { kind: "machine", id: "order-command", permissions: ctx.config.commandPermissions } });
    const orders = createOrders(database.orders, jobs.for("orders/create"));
    return { orders, access: createAccess(createIdentity(ctx.config.token)), pages: createPages(orders) };
}
