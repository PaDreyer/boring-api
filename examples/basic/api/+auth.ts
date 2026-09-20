import { timingSafeEqual } from "crypto";
import type { AuthenticationContext, AuthorizationContext } from "./$types";
import { permissionsForRoles, requireAccess } from "$modules/access/facade";
import type { AuthorizationRule } from "$modules/access/schemas";

/** Example only: replace this file with the application's identity provider. */
export function authenticate(ctx: AuthenticationContext) {
    const expected = process.env.BORING_API_TOKEN;
    const header = ctx.request.header("authorization");
    if (!expected || !header?.startsWith("Bearer ")) return;

    const actual = Buffer.from(header.slice(7));
    const secret = Buffer.from(expected);
    if (actual.length === secret.length && timingSafeEqual(actual, secret)) {
        const roles = ["admin"] as const;
        return { kind: "user" as const, id: "demo-operator", roles, permissions: permissionsForRoles(roles) };
    }
}

export function authorize(ctx: AuthorizationContext, rule: AuthorizationRule): void {
    requireAccess(ctx.session, rule);
}
