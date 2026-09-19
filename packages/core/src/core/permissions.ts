import { HttpError } from "./errors";

/** A permission, all listed permissions, or at least one listed permission. */
export type PermissionRule<Permission extends string = string> =
    | Permission
    | { readonly allOf: readonly [Permission, ...Permission[]]; readonly anyOf?: never }
    | { readonly anyOf: readonly [Permission, ...Permission[]]; readonly allOf?: never };

function permissionName(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

/** Throws on denial. Invalid rules are programming errors, not permission denials. */
export function requirePermissions<Permission extends string>(
    granted: readonly string[] | ReadonlySet<string>,
    rule: PermissionRule<Permission>,
): void {
    let required: readonly string[];
    let mode: "allOf" | "anyOf" = "allOf";
    if (permissionName(rule)) {
        required = [rule];
    } else {
        if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
            throw new TypeError("Permission rule must be a non-empty string or an allOf/anyOf object");
        }
        const keys = Object.keys(rule);
        if (keys.length !== 1 || (keys[0] !== "allOf" && keys[0] !== "anyOf")) {
            throw new TypeError("Permission rule must contain exactly one of allOf or anyOf");
        }
        mode = keys[0];
        const values = rule[mode];
        if (!Array.isArray(values) || values.length === 0 || !Array.from(values).every(permissionName)) {
            throw new TypeError(`${mode} must be a non-empty array of permission names`);
        }
        required = values;
    }

    const permissions = new Set(granted);
    const allowed = mode === "allOf"
        ? required.every(permission => permissions.has(permission))
        : required.some(permission => permissions.has(permission));
    if (!allowed) throw new HttpError(403, "Forbidden");
}
