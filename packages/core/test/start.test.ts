import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import ts from "typescript";
import { readConfiguration } from "../src/core/config";
import { resolveStartDirectory } from "../src/core/start";

const { before, after } = require("node:test");
const repository = join(__dirname, "..");
const suite = mkdtempSync(join(tmpdir(), "boring-start-"));
const library = join(suite, "library");
const cli = join(library, "cli.js");

function write(root: string, file: string, value: string): void {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, value);
}

function dependencies(root: string): void {
    mkdirSync(join(root, "node_modules/@boringapi"), { recursive: true });
    symlinkSync(library, join(root, "node_modules/@boringapi/core"), "dir");
    for (const dependency of ["zod", "@types"]) {
        symlinkSync(join(repository, "node_modules", dependency), join(root, "node_modules", dependency), "dir");
    }
}

before(() => {
    const configuration = readConfiguration(repository);
    const program = ts.createProgram(configuration.fileNames, { ...configuration.options, outDir: library });
    assert.equal(program.emit().emitSkipped, false);
    write(library, "package.json", JSON.stringify({ name: "@boringapi/core", main: "index.js", types: "index.d.ts" }));
    symlinkSync(join(repository, "node_modules"), join(library, "node_modules"), "dir");
});
after(() => rmSync(suite, { recursive: true, force: true }));

function fixture(api = "api"): string {
    const root = mkdtempSync(join(suite, "consumer-"));
    write(root, "package.json", '{"name":"start-consumer","private":true}');
    dependencies(root);
    write(root, "tsconfig.json", JSON.stringify({
        extends: "./.boring/tsconfig.json",
        compilerOptions: { target: "ES2020", module: "commonjs", moduleResolution: "node", strict: true, esModuleInterop: true, skipLibCheck: true },
        include: [`${api}/**/*.ts`, `${dirname(api)}/modules/**/*.ts`],
    }));
    write(root, `${dirname(api)}/modules/health/facade.ts`, 'export const health = () => ({ status: "ok" });');
    write(root, `${api}/+setup.ts`, [
        'import { health } from "$modules/health/facade";',
        'import type { SetupContext } from "./$types";',
        'export const setup = (_ctx: SetupContext) => ({ health });',
    ].join("\n"));
    write(root, `${api}/get.ts`, [
        'import type { GetHandler } from "./$types";',
        'export const handler: GetHandler = ctx => ctx.services.health();',
    ].join("\n"));
    return root;
}

function run(root: string, args: string[]) {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8", timeout: 15000 });
    assert.ifError(result.error);
    return result;
}

function build(root: string, args: string[] = []): void {
    const result = run(root, ["build", ...args]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

async function serves(root: string, args: string[] = []): Promise<void> {
    const child = spawn(process.execPath, [cli, "start", ...args, "--port", "0"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    try {
        const port = await new Promise<number>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error(`Start timed out:\n${output}`)), 10000);
            const finish = (error?: Error, value?: number) => {
                clearTimeout(timeout);
                if (error) reject(error); else resolve(value!);
            };
            child.once("error", error => finish(error));
            child.once("exit", code => finish(new Error(`Start exited with ${code}:\n${output}`)));
            const receive = (chunk: Buffer) => {
                output += chunk.toString();
                const match = /Listening on port (\d+)/.exec(output);
                if (match) finish(undefined, Number(match[1]));
            };
            child.stdout.on("data", receive);
            child.stderr.on("data", receive);
        });
        const response = await fetch(`http://127.0.0.1:${port}/`);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { status: "ok" });
        assert.ok(!output.includes("Generated"), "start must not regenerate types");
    } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        await exited;
    }
}

it("boring build followed by boring start serves compiled aliases and hook types with no path arguments", async () => {
    const root = fixture();
    build(root);
    const manifest = JSON.parse(readFileSync(join(root, "dist/.boring-build.json"), "utf8"));
    assert.equal(manifest.apiDirectory, "api");
    write(root, "api/get.ts", 'throw new Error("SOURCE MUST NOT EXECUTE");');
    await serves(root);
});

it("start remembers custom build projects and nested output paths and keeps the last successful build", async () => {
    const root = fixture("app/http");
    write(root, "tsconfig.build.json", JSON.stringify({ extends: "./tsconfig.json", compilerOptions: { rootDir: ".", outDir: "release/server" } }));
    build(root, ["app/http", "--project", "tsconfig.build.json"]);
    assert.equal(JSON.parse(readFileSync(join(root, "release/server/.boring-build.json"), "utf8")).apiDirectory, "app/http");
    await serves(root);
    await serves(root, ["--project", "tsconfig.build.json"]);
    const reference = readFileSync(join(root, ".boring/build.json"), "utf8");
    write(root, "app/http/get.ts", "export const handler = 42;");
    write(root, "tsconfig.failed.json", JSON.stringify({ extends: "./tsconfig.json", compilerOptions: { outDir: "failed-build" } }));
    assert.equal(run(root, ["build", "app/http", "--project", "tsconfig.failed.json"]).status, 1);
    assert.equal(readFileSync(join(root, ".boring/build.json"), "utf8"), reference);
    assert.equal(existsSync(join(root, "failed-build")), false);
    await serves(root);
});

it("start supports relocated deployments without sources, generated types or configuration", async () => {
    const source = fixture("src/http");
    build(source, ["src/http"]);
    const deployment = mkdtempSync(join(suite, "deployment-"));
    write(deployment, "package.json", '{"name":"deployment","private":true}');
    dependencies(deployment);
    cpSync(join(source, "dist"), join(deployment, "dist"), { recursive: true });
    rmSync(source, { recursive: true });
    await serves(deployment);
    assert.equal(existsSync(join(deployment, ".boring")), false);
    renameSync(join(deployment, "dist"), join(deployment, "artifact"));
    await serves(deployment, ["--out-dir", "artifact"]);
    await serves(deployment, ["artifact/http"]);
    await serves(deployment, ["--dir", "artifact/http"]);
    write(deployment, "tsconfig.runtime.json", '{"compilerOptions":{"outDir":"artifact"},"include":["missing/**/*.ts"]}');
    await serves(deployment, ["--project", "tsconfig.runtime.json"]);
});

it("start rejects missing builds and ambiguous or incomplete command options without executing source", () => {
    const root = fixture();
    write(root, "api/get.ts", 'throw new Error("SOURCE MUST NOT EXECUTE");');
    const missing = run(root, ["start"]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Run boring build/);
    assert.doesNotMatch(missing.stderr, /SOURCE MUST NOT EXECUTE/);
    for (const args of [["--out-dir"], ["--dir"], ["--project"], ["--port"], ["dist/api", "--out-dir", "dist"], ["--project", "tsconfig.json", "--out-dir", "dist"]]) {
        const result = run(root, ["start", ...args]);
        assert.equal(result.status, 1, JSON.stringify(args));
        assert.match(result.stderr, /requires a value|Choose one start target/);
    }
});

it("start validates build metadata instead of following malformed or escaping paths", () => {
    const root = fixture();
    const manifest = "dist/.boring-build.json";
    for (const contents of ["{", "null", '{"version":99}', '{"version":1,"apiDirectory":"../../other"}', '{"version":1,"apiDirectory":"/tmp"}']) {
        write(root, manifest, contents);
        assert.throws(() => resolveStartDirectory(root, {}), /build metadata/);
    }
    write(root, ".boring/build.json", '{"version":1,"outputDirectory":"../elsewhere"}');
    assert.throws(() => resolveStartDirectory(root, {}), /Invalid directory/);
});
