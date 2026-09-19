import type { PermissionRule } from "@boringapi/core";

export type Permission = "orders:read" | "orders:create";
export type AuthorizationRule = PermissionRule<Permission>;
export interface Actor { id: string; permissions: readonly Permission[]; }
