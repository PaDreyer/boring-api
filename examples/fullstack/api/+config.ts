import { z } from "zod";
import type { ConfigEnvironment } from "./$types";

export const schema = z.object({
    databaseUrl: z.string().url().refine(value => /^postgres(?:ql)?:/.test(value), "Expected a PostgreSQL URL"),
    token: z.string().min(1).optional(),
});
export function load(env: ConfigEnvironment) {
    return { databaseUrl: env.DATABASE_URL, token: env.BORING_API_TOKEN };
}
