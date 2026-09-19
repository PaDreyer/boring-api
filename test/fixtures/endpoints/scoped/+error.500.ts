import { Context } from "../../../../src";

export function handler(ctx: Context) {
    return { error: { message: "Scoped failure" }, marker: ctx.get("scopeMarker") };
}
