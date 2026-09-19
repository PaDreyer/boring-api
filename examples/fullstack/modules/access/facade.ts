import { timingSafeEqual } from "node:crypto";
import { requirePermissions } from "../../../../src";
import type { Actor, AuthorizationRule } from "./schemas";

export function requireAccess(actor: Actor, rule: AuthorizationRule): void {
    requirePermissions(actor.permissions, rule);
}

/** Demonstration identity provider; configure the token outside source control. */
export function createAccess(token: string | undefined) {
    return {
        authenticate(header: string | undefined): Actor | undefined {
            if (!token || !header?.startsWith("Bearer ")) return undefined;
            const candidate = Buffer.from(header.slice(7));
            const expected = Buffer.from(token);
            if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) return undefined;
            return { id: "demo-operator", permissions: ["orders:read", "orders:create"] };
        },
    };
}
