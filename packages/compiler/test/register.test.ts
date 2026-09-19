import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { registerTypeScript } from "../src/register";

it("registers isolated source compilers without the CLI or generated project files", async () => {
    const root = mkdtempSync(join(tmpdir(), "boring-compiler-"));
    const previous = require.extensions[".ts"];
    const unregister: (() => void)[] = [];
    try {
        for (const name of ["first", "second"]) {
            const project = join(root, name);
            const files = {
                "tsconfig.json": '{"compilerOptions":{"module":"commonjs","target":"es2020"}}',
                "infra/value.ts": `export const value: string = ${JSON.stringify(name)};`,
                "modules/orders/facade.ts": 'export { value } from "$infra/value";',
                "api/get.ts": 'import { value } from "$modules/orders/facade"; export const handler = () => value;',
            };
            for (const [file, content] of Object.entries(files)) {
                mkdirSync(dirname(join(project, file)), { recursive: true });
                writeFileSync(join(project, file), content);
            }
            unregister.push(registerTypeScript(join(project, "api")));
        }
        assert.equal(require(join(root, "first/api/get.ts")).handler(), "first");
        assert.equal(require(join(root, "second/api/get.ts")).handler(), "second");
    } finally {
        for (const stop of unregister.reverse()) stop();
        rmSync(root, { recursive: true, force: true });
    }
    assert.equal(require.extensions[".ts"], previous);
});
