import type { AuthenticationContext, AuthorizationContext } from "./$types";
import type { AuthorizationRule } from "$modules/access/schemas";
import { requireAccess } from "$modules/access/facade";

export function authenticate(ctx: AuthenticationContext) { return ctx.services.access.authenticate(ctx.request.header("authorization")); }
export function authorize(ctx: AuthorizationContext, rule: AuthorizationRule) { requireAccess(ctx.session, rule); }
