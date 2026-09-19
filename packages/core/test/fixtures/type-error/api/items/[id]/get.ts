import z from "zod";
import type { GetHandler } from "./$types";

export const params = z.object({ id: z.string() });
export const output = z.object({ id: z.string() });

export const handler: GetHandler = ctx => ({ id: ctx.params.missing });
