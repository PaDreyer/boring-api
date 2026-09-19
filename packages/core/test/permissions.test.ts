import assert from "node:assert/strict";
import { it } from "node:test";
import { HttpError, PermissionRule, requirePermissions } from "../src";

it("checks exact permissions and explicit allOf/anyOf rules", () => {
    const reader = ["orders:read"];
    const both = new Set(["orders:read", "orders:create"]);
    assert.doesNotThrow(() => requirePermissions(reader, "orders:read"));
    assert.doesNotThrow(() => requirePermissions(both, { allOf: ["orders:read", "orders:create"] }));
    assert.doesNotThrow(() => requirePermissions(reader, { anyOf: ["orders:create", "orders:read"] }));
    assert.doesNotThrow(() => requirePermissions(["orders:create"], { anyOf: ["orders:create", "orders:read"] }));

    for (const rule of ["orders:create", { allOf: ["orders:read", "orders:create"] }] as const) {
        assert.throws(() => requirePermissions(reader, rule), { status: 403, message: "Forbidden" });
    }
    for (const rule of ["orders:read", { allOf: ["orders:read"] }, { anyOf: ["orders:read", "orders:create"] }] as const) {
        assert.throws(() => requirePermissions([], rule), { status: 403, message: "Forbidden" });
    }
    for (const grants of [["admin"], ["*"], ["orders:*"], ["orders:reader"]]) {
        assert.throws(() => requirePermissions(grants, "orders:read"), { status: 403 });
    }
    assert.deepEqual(reader, ["orders:read"]);
    assert.deepEqual([...both], ["orders:read", "orders:create"]);
});

it("rejects malformed permission rules as programming errors, even with sufficient grants", () => {
    const invalid: unknown[] = [
        undefined, null, false, "", " ", [], ["orders:read"], {},
        { allOf: [] }, { anyOf: [] }, { allOf: new Array(1) },
        { allOf: ["orders:read", ""] }, { anyOf: ["orders:read", 42] },
        { allOf: "orders:read" }, { anyOf: { allOf: ["orders:read"] } },
        { allOf: ["orders:read"], anyOf: ["orders:read"] },
        { allOf: ["orders:read"], anyOf: undefined },
        { allOf: ["orders:read"], extra: true },
    ];
    for (const rule of invalid) {
        assert.throws(() => requirePermissions(["orders:read"], rule as PermissionRule), error =>
            error instanceof TypeError && !(error instanceof HttpError));
    }
});

