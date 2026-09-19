import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { it } from "node:test";

const repository = join(__dirname, "..");

function project(files: Record<string, string>, run: (root: string) => void): void {
    const root = mkdtempSync(join(tmpdir(), "boring-architecture-"));
    try {
        for (const [name, text] of Object.entries({
            "package.json": '{"name":"architecture-consumer","private":true}',
            "api/get.ts": "export const handler = () => null;",
            ...files,
        })) {
            const file = join(root, name);
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, text);
        }
        run(root);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}


it("boring check enforces architecture, includes unused modules, and has no opt-out", () => {
    project({
        "infra/db.js": 'exports.query = () => null;',
        "api/get.js": 'exports.handler = () => null;',
        "modules/unused/facade.ts": 'import { handler } from "../../api/get"; export const run = handler;',
    }, root => {
        rmSync(join(root, "api/get.ts"));
        const run = (args: string[] = []) => spawnSync(process.execPath, [
            join(repository, "bin/boring.cjs"), "check", "api", ...args,
        ], { cwd: root, encoding: "utf8", env: { ...process.env, TS_NODE_PROJECT: join(repository, "tsconfig.json") } });
        const result = run();
        assert.equal(result.status, 1);
        assert.match(`${result.stdout}\n${result.stderr}`, /modules[/\\]unused[/\\]facade.ts:1:\d+ - error BORING104/);
        const disabled = run(["--no-architecture"]);
        assert.equal(disabled.status, 1);
        assert.match(disabled.stderr, /Unknown option/);
    });
});
