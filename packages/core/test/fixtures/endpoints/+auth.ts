import { Context, HttpError } from "../../../src";

export async function authenticate(ctx: Context) {
    await new Promise(resolve => setTimeout(resolve, 5));
    if (ctx.request.header("authorization") === "Bearer test") {
        ctx.set("session", { kind: "user", id: "admin", permissions: [], role: "admin" });
    } else if (ctx.request.header("authorization") === "Bearer viewer") {
        ctx.set("session", { kind: "user", id: "viewer", permissions: [], role: "viewer" });
    }
}

export async function authorize(ctx: Context, role: unknown) {
    await Promise.resolve();
    if ((ctx.get("session") as { role: string }).role !== role) {
        throw new HttpError(403, "Forbidden");
    }
}
