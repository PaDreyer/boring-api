import z from "zod";
import type { GetHandler } from "./$types";

export const params = z.object({ id: z.string().regex(/^[A-Za-z0-9-]+$/) });
export const query = z.object({ detail: z.enum(["short", "full"]).optional() });
export const output = z.object({ id: z.string(), detail: z.enum(["short", "full"]).optional() });
export const envelope = false;

export const handler: GetHandler = ctx => {
    const { id } = ctx.params;
    const { detail } = ctx.query;
    const section: "items" = ctx.locals.section;
    void section;
    return { id, ...(detail ? { detail } : {}) };
};
