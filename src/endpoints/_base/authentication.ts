import { Context } from "../../core/context";

export function handler(ctx: Context) {
    const query = ctx.get("query");

    if (query && query.pw === "123") {
        ctx.set("session", {
            user: "peter",
            role: "admin"
        })
    }
}