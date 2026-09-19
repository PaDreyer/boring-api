import type { GetHandler } from "./$types";

export const authorization = {
    anyOf: ["orders:read", "orders:create"],
} as const;

export const handler: GetHandler = ctx => ({ permissions: ctx.session.permissions });
