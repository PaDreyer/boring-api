import { Context } from "../../../../src";

export function handler(ctx: Context) {
    ctx.set("scopeMarker", "from-middleware");
}
