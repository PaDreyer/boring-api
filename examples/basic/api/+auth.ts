import { timingSafeEqual } from "crypto";
import { Context } from "../../../src";
import { permissionsForRoles, requireAccess } from "../modules/access/facade";
import type { AuthorizationRule } from "../modules/access/schemas";

/** Example only: replace this file with the application's identity provider. */
export function authenticate(ctx: Context) {
    const expected = process.env.BORING_API_TOKEN;
    const header = ctx.request.header("authorization");
    if (!expected || !header?.startsWith("Bearer ")) return;

    const actual = Buffer.from(header.slice(7));
    const secret = Buffer.from(expected);
    if (actual.length === secret.length && timingSafeEqual(actual, secret)) {
        const roles = ["admin"] as const;
        return { roles, permissions: permissionsForRoles(roles) };
    }
}

export function authorize(ctx: Context, rule: AuthorizationRule): void {
    // The pipeline requires a session before calling authorize().
    const session = ctx.session as NonNullable<ReturnType<typeof authenticate>>;
    requireAccess(session, rule);
}
