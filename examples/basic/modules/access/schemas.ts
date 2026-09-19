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
