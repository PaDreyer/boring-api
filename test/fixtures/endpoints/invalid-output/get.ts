import z from "zod";

export const output = z.object({ ok: z.literal(true) });

export function handler() {
    return { ok: false };
}
