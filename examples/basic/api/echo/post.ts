import z from "zod";
import type { PostHandler } from "./$types";

export const body = z.object({ message: z.string().min(1) });
export const output = body;
export const handler: PostHandler = ctx => ctx.body;
