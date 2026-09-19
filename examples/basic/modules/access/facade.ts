import { requirePermissions } from "../../../../src";
import type { Actor, AuthorizationRule, Permission } from "./schemas";

/** Roles bundle permissions; no role receives implicit or wildcard access. */
export const rolePermissions = {
    viewer: ["orders:read"],
    creator: ["orders:create"],
    admin: ["orders:read", "orders:create"],
} as const satisfies Record<string, readonly Permission[]>;

export type Role = keyof typeof rolePermissions;

export function permissionsForRoles(roles: readonly Role[]): Permission[] {
    const granted = new Set<Permission>();
    for (const role of roles) {
        if (!Object.prototype.hasOwnProperty.call(rolePermissions, role)) {
            throw new TypeError(`Unknown role: ${role}`);
        }
        for (const permission of rolePermissions[role]) granted.add(permission);
    }
    return [...granted];
}

/** Shared by the HTTP hook and business operations, including non-HTTP callers. */
export function requireAccess(actor: Actor, rule: AuthorizationRule): void {
    requirePermissions(actor.permissions, rule);
}
