import assert from "node:assert/strict";
import { it } from "node:test";
import { permissionsForRoles, requireAccess, Role } from "../modules/access/facade";

it("unions explicit role grants without sharing request permissions or granting implicit access", () => {
    assert.deepEqual(permissionsForRoles([]), []);
    assert.deepEqual(permissionsForRoles(["viewer"]), ["orders:read"]);
    assert.deepEqual(permissionsForRoles(["creator"]), ["orders:create"]);
    assert.deepEqual(permissionsForRoles(["viewer", "creator", "viewer"]), ["orders:read", "orders:create"]);
    assert.deepEqual(permissionsForRoles(["admin"]), ["orders:read", "orders:create"]);
    const first = permissionsForRoles(["viewer"]);
    first.push("orders:create");
    assert.deepEqual(permissionsForRoles(["viewer"]), ["orders:read"]);
    for (const role of ["unknown", "toString", "__proto__"]) {
        assert.throws(() => permissionsForRoles([role as Role]), /Unknown role/);
    }
    const namedAdmin = { role: "admin", permissions: [] };
    assert.throws(() => requireAccess(namedAdmin, "orders:read"), { status: 403 });
});
