import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { generateTypes } from "../src";

it("never writes generated types outside .boring when the API is outside the project", () => {
    const base = mkdtempSync(join(tmpdir(), "boring-api-containment-"));
    const root = join(base, "nested", "project");
    const externalApi = join(base, "api");
    const unrelated = join(root, "api");
    try {
        mkdirSync(root, { recursive: true });
        mkdirSync(externalApi);
        mkdirSync(unrelated);
        writeFileSync(join(externalApi, "get.ts"), "export const handler = () => ({ ok: true });\n");
        writeFileSync(join(unrelated, "KEEP"), "do not delete\n");

        assert.throws(() => generateTypes(root, externalApi), /must be inside the project root/);
        assert.equal(readFileSync(join(unrelated, "KEEP"), "utf8"), "do not delete\n");
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

it("rejects symbolic links that redirect generated types outside the project", () => {
    const base = mkdtempSync(join(tmpdir(), "boring-api-output-link-"));
    const root = join(base, "project");
    const api = join(root, "api");
    const victim = join(base, "victim");
    try {
        mkdirSync(api, { recursive: true });
        mkdirSync(join(root, ".boring"));
        mkdirSync(join(victim, "api"), { recursive: true });
        writeFileSync(join(api, "get.ts"), "export const handler = () => ({ ok: true });\n");
        writeFileSync(join(victim, "api", "KEEP"), "do not delete\n");
        symlinkSync(victim, join(root, ".boring", "types"), "dir");

        assert.throws(() => generateTypes(root, api), /must not contain symbolic links/);
        assert.equal(readFileSync(join(victim, "api", "KEEP"), "utf8"), "do not delete\n");
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

