import type { GetHandler } from "./$types";

export const authentication = true;
export const authorization = "admin";

export const handler: GetHandler = ctx => ({ role: ctx.session.role });
