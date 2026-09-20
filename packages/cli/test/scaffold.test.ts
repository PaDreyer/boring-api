import { formatHost } from "@boringapi/compiler";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import ts from "typescript";
import { analyzeProject } from "@boringapi/analyzer";

const { after } = require("node:test");
const repository = join(__dirname, "..");
const suite = mkdtempSync(join(tmpdir(), "boring-scaffold-"));
const library = dirname(require.resolve("@boringapi/core/package.json"));
function write(root: string, file: string, content: string) {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
}
after(() => rmSync(suite, { recursive: true, force: true }));

function fresh() { return mkdtempSync(join(suite, "consumer-")); }
function dependencies(root: string) {
    mkdirSync(join(root, "node_modules/@boringapi"), { recursive: true });
    symlinkSync(library, join(root, "node_modules/@boringapi/core"), "dir");
    symlinkSync(join(repository, "node_modules/zod"), join(root, "node_modules/zod"), "dir");
    symlinkSync(join(repository, "node_modules/@types"), join(root, "node_modules/@types"), "dir");
}
function checked(root: string, api = "api", projectFile?: string) {
    const result = analyzeProject(root, api, projectFile);
    assert.equal(result.diagnostics.length, 0, ts.formatDiagnostics(result.diagnostics, formatHost(root)));
    assert.deepEqual(result.architecture.map(error => error.message), []);
    return result;
}
function cli(root: string, args: string[]) {
    return spawnSync(process.execPath, [join(repository, "dist/cli.js"), ...args], { cwd: root, encoding: "utf8" });
}
it("ships working CLI commands, generated HTTP tests and project configuration selection", () => {
    const root = fresh();
    const result = cli(root, ["init", ".", "--dir", "src/http"]);
    assert.equal(result.status, 0, result.stderr);
    dependencies(root);
    assert.equal(cli(root, ["add", "module", "invoices", "--dir", "src/http"]).status, 0);
    const copied = cli(root, ["add", "endpoint", "health/live/get", "--dir", "src/http", "--from", "health/get"]);
    assert.equal(copied.status, 0, copied.stderr);
    const built = cli(root, ["build", "src/http"]);
    assert.equal(built.status, 0, built.stderr);
    // This is a separate consumer test run, not a worker of the repository runner.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const test = spawnSync(process.execPath, ["--test", "test/health.test.cjs"], { cwd: root, encoding: "utf8", env });
    assert.equal(test.status, 0, `${test.stdout}\n${test.stderr}`);
    assert.match(test.stdout, /serves the health contract/);
    for (const args of [["add", "module"], ["add", "endpoint", "foo/get", "--from"], ["init", "--project", "tsconfig.json"], ["add", "module", "foo", "--from", "health/get"], ["add", "endpoint", "foo/get", "--force"]]) {
        assert.equal(cli(root, args).status, 1, args.join(" "));
    }
    const config = readFileSync(join(root, "tsconfig.json"), "utf8");
    write(root, "tsconfig.app.json", config);
    write(root, "tsconfig.json", '{"compilerOptions":{"notAnOption":true}}');
    const selected = cli(root, ["add", "endpoint", "invoices/get", "--dir", "src/http", "--project", "tsconfig.app.json"]);
    assert.equal(selected.status, 0, selected.stderr);
    checked(root, "src/http", "tsconfig.app.json");
});
