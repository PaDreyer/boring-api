import { requirePermissions } from "@boringapi/core";
import type { Actor, AuthorizationRule, Permission } from "./schemas";

import { rolePermissions } from "./schemas";
import type { Role } from "./schemas";
export type { Role } from "./schemas";

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
