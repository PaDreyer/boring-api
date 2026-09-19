import z from "zod";
import type { GetHandler } from "./$types";

export const output = z.object({ service: z.string(), status: z.literal("ok") });
export const envelope = false;

export const handler: GetHandler = ctx => ({ service: ctx.services.serviceName, status: "ok" });
