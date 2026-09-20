import { Context, PermissionRule, requirePermissions } from "../../../src";

type Permission = "orders:read" | "orders:create";

export async function authenticate(ctx: Context) {
    await new Promise(resolve => setTimeout(resolve, 5));
    const identity = ctx.request.header("authorization");
    if (!identity) return;
    const permissions: Permission[] = [];
    if (identity === "reader" || identity === "both") permissions.push("orders:read");
    if (identity === "creator" || identity === "both") permissions.push("orders:create");
    return { kind: "user" as const, id: identity, permissions };
}

export async function authorize(ctx: Context, rule: PermissionRule<Permission>) {
    await Promise.resolve();
    if (ctx.request.header("authorization") === "failure") throw new Error("private auth failure");
    const session = ctx.session as NonNullable<Awaited<ReturnType<typeof authenticate>>>;
    requirePermissions(session.permissions, rule);
}
