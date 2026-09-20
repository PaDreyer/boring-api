import type { PermissionRule } from "@boringapi/core";

/** Application-owned names and descriptions; reuse these before adding permissions. */
export const permissions = {
    "orders:read": "Read orders",
    "orders:create": "Create orders",
} as const;

export type Permission = keyof typeof permissions;
export type AuthorizationRule = PermissionRule<Permission>;

/** Supplied by trusted callers, never copied from request input. */
export interface Actor {
    readonly permissions: readonly Permission[];
}

/** Roles bundle permissions; no role receives implicit or wildcard access. */
export const rolePermissions = {
    viewer: ["orders:read"],
    creator: ["orders:create"],
    admin: ["orders:read", "orders:create"],
} as const satisfies Record<string, readonly Permission[]>;

export type Role = keyof typeof rolePermissions;
