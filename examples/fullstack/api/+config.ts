import { z } from "zod";
import type { ConfigEnvironment } from "./$types";

export const schema = z.object({
    databaseUrl: z.string().url().refine(value => /^postgres(?:ql)?:/.test(value), "Expected a PostgreSQL URL"),
    workerPermissions: z.array(z.enum(["orders:create"])),
    schedulePermissions: z.array(z.enum(["orders:create"])),
    eventPermissions: z.array(z.enum(["orders:create", "orders:observe"])),
    publisherPermissions: z.array(z.enum(["orders:create", "orders:observe"])),
    commandPermissions: z.array(z.enum(["orders:create"])),
    token: z.string().min(1).optional(),
});
export function load(env: ConfigEnvironment) {
    return { schedulePermissions: env.BORING_SCHEDULE_PERMISSIONS?.split(",").filter(Boolean) ?? [],
        eventPermissions: env.BORING_EVENT_PERMISSIONS?.split(",").filter(Boolean) ?? [],
        publisherPermissions: env.BORING_PUBLISHER_PERMISSIONS?.split(",").filter(Boolean) ?? [],
        commandPermissions: env.BORING_COMMAND_PERMISSIONS?.split(",").filter(Boolean) ?? [], databaseUrl: env.DATABASE_URL, token: env.BORING_API_TOKEN, workerPermissions: env.BORING_WORKER_PERMISSIONS === "" ? [] : env.BORING_WORKER_PERMISSIONS?.split(",") ?? ["orders:create"] };
}
