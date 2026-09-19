import type { EnvelopeContext } from "./$types";

export function handler(ctx: EnvelopeContext) {
    return { data: ctx.payload };
}
