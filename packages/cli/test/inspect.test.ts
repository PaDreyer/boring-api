import type { Inspection } from "@boringapi/analyzer";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";

const repository = process.cwd();
function write(root: string, file: string, text: string) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
}
function project(files: Record<string, string>, run: (root: string) => void | Promise<void>) {
    const root = mkdtempSync(join(tmpdir(), "boring-inspect-"));
    let pending = false;
    try {
        write(root, "package.json", '{"name":"inspect-consumer","private":true}');
        write(root, "tsconfig.json", JSON.stringify({ compilerOptions: {
            target: "ES2020", module: "commonjs", moduleResolution: "node", esModuleInterop: true,
            strict: true, skipLibCheck: true, allowJs: true, baseUrl: ".",
            paths: { "@boringapi/core": [require.resolve("@boringapi/core").replace(/\.js$/, ".d.ts")],
                zod: [join(repository, "node_modules/zod")], "@orders/*": ["modules/orders/*"] },
        }, include: ["api/**/*"] }));
        for (const [file, text] of Object.entries(files)) write(root, file, text);
        const result = run(root);
        if (result) { pending = true; return result.finally(() => rmSync(root, { recursive: true, force: true })); }
    } finally { if (!pending) rmSync(root, { recursive: true, force: true }); }
}
function cli(root: string, args = ["inspect", "api", "--json"]) {
    return spawnSync(process.execPath, [join(repository, "bin/boring.cjs"), ...args], {
        cwd: root, encoding: "utf8", maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, TS_NODE_PROJECT: join(repository, "tsconfig.json") },
    });
}

it("prints one stable JSON document and refuses invalid contracts and unused architecture violations", () => {
    project({ "api/get.ts": 'throw new Error("EXECUTED route"); export const handler = () => ({ ok: true });' }, root => {
        const good = cli(root, ["inspect", "--dir", "api", "--json"]);
        assert.equal(good.status, 0, good.stderr);
        const result: Inspection = JSON.parse(good.stdout);
        assert.equal(result.schemaVersion, 2);
        assert.equal(result.routes[0].path, "/");
        assert.equal(result.routes[0].source.file, "api/get.ts");
        assert.ok(!good.stdout.includes(root));
        const readable = cli(root, ["inspect", "api"]);
        assert.equal(readable.status, 0, readable.stderr);
        assert.match(readable.stdout, /GET \/ — api\/get.ts:1:/);
        write(root, "modules/unused/facade.ts", 'import { handler } from "../../api/get"; export const bad = handler;');
        const violation = cli(root);
        assert.equal(violation.status, 1);
        assert.equal(violation.stdout, "");
        assert.match(violation.stderr, /BORING104/);
        rmSync(join(root, "modules"), { recursive: true });
        write(root, "api/get.ts", 'export const handler = 42;');
        const contract = cli(root);
        assert.equal(contract.status, 1);
        assert.equal(contract.stdout, "");
        assert.match(contract.stderr, /TS2344/);
    });
});
