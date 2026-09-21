import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { resolveStartDirectory } from "@boringapi/build";

const { after } = require("node:test");
const repository = join(__dirname, "..");
const suite = mkdtempSync(join(tmpdir(), "boring-start-"));
const library = dirname(require.resolve("@boringapi/core/package.json"));
const cli = join(repository, "dist/cli.js");

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

async function serves(root: string, args: string[] = [], entry?: string, signal: NodeJS.Signals = "SIGTERM"): Promise<string> {
    const child = spawn(process.execPath, entry ? [entry] : [cli, "start", ...args, "--port", "0"], {
        cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PORT: "0" },
    });
    let output = "";
    const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
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
        const force = setTimeout(() => child.kill("SIGKILL"), 5000);
        if (child.exitCode === null && child.signalCode === null) child.kill(signal);
        await exited;
        clearTimeout(force);
        assert.notEqual(child.signalCode, "SIGKILL", `${signal} must terminate the server without a forced kill`);
        assert.equal(child.exitCode, 0, output);
    }
    return output;
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

it("runs the generated entry point after relocation with no CLI or compiler imports", async () => {
    const source = fixture("app/http");
    write(source, "tsconfig.build.json", JSON.stringify({ extends: "./tsconfig.json", compilerOptions: { rootDir: ".", outDir: "release/server" } }));
    build(source, ["app/http", "--project", "tsconfig.build.json"]);
    const deployment = mkdtempSync(join(suite, "runtime-"));
    dependencies(deployment);
    cpSync(join(source, "release/server"), join(deployment, "artifact"), { recursive: true });
    rmSync(source, { recursive: true });
    write(deployment, "start.cjs", `
        const Module = require("node:module");
        const original = Module._load;
        Module._load = function(id, ...args) {
            if (["typescript", "ts-node", "@boringapi/cli"].some(name => id === name || id.startsWith(name + "/"))) {
                throw new Error("Unexpected production dependency: " + id);
            }
            return original.call(this, id, ...args);
        };
        require("./artifact/boring-start.cjs");
    `);
    await serves(deployment, [], join(deployment, "start.cjs"));
    const invalid = spawnSync(process.execPath, [join(deployment, "start.cjs")], {
        cwd: deployment, encoding: "utf8", env: { ...process.env, PORT: "invalid" },
    });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /PORT must be an integer/);
});

it("disposes application-owned background resources on SIGINT and SIGTERM", async () => {
    const root = fixture();
    const setup = "api/+setup.ts";
    write(root, setup, `import { health } from "$modules/health/facade";
import type { SetupContext } from "./$types";
export function setup(ctx: SetupContext) {
    const timer = setInterval(() => {}, 1000);
    ctx.onClose("timer", async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        clearInterval(timer);
        console.info("timer disposed");
    });
    return { health };
}`);
    build(root);
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
        assert.match(await serves(root, [], join(root, "dist/boring-start.cjs"), signal), /timer disposed/);
        assert.match(await serves(root, [], undefined, signal), /timer disposed/);
    }
});

it("rejects source that collides with the generated entry point before replacing a successful build", () => {
    const root = fixture();
    build(root);
    const previous = readFileSync(join(root, "dist/boring-start.cjs"), "utf8");
    write(root, "boring-start.cts", 'export const custom = true;');
    write(root, "tsconfig.json", JSON.stringify({
        extends: "./.boring/tsconfig.json",
        compilerOptions: { module: "commonjs", target: "ES2020", esModuleInterop: true, strict: true, skipLibCheck: true },
        include: ["api/**/*.ts", "modules/**/*.ts", "boring-start.cts"],
    }));
    const result = run(root, ["build"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /boring-start.cjs is reserved/);
    assert.equal(readFileSync(join(root, "dist/boring-start.cjs"), "utf8"), previous);
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

it("runs schema-checked application commands through source and compiled CLI without argument grants", () => {
    const root = fixture();
    write(root, "api/+config.ts", 'import {z} from "zod"; export const schema=z.object({grants:z.array(z.string())}); export function load(env:Readonly<Record<string,string|undefined>>) {return {grants:env.TEST_COMMAND_GRANTS?.split(",")??[]};}');
    write(root, "modules/health/facade.ts", 'import type {ExecutionContext} from "@boringapi/core"; import {requirePermissions} from "@boringapi/core"; export function health(ctx:ExecutionContext,input:{status:string}) {requirePermissions(ctx.identity?.permissions??[],"health:run");return input;}');
    write(root, "api/+setup.ts", 'import {health} from "$modules/health/facade"; import type {SetupContext} from "./$types"; export function setup(ctx:SetupContext) {ctx.commands({identity:{kind:"machine",id:"cli",permissions:ctx.config.grants}});ctx.onClose("test",()=>console.error("disposed"));return {health};}');
    write(root, "api/get.ts", 'import type {GetHandler} from "./$types"; export const handler:GetHandler=ctx=>ctx.services.health(ctx.execution,{status:"ok"});');
    write(root, "commands/health/run/command.ts", 'import {z} from "zod"; import type {CommandHandler} from "./$types"; export const input=z.object({status:z.string()}).strict(); export const output=input; export const timeoutMs=1000; export const handler:CommandHandler=ctx=>ctx.services.health(ctx.execution,ctx.input);');
    build(root);
    for(const mode of [["--source"], ["--out-dir","dist"]]) {
        const invoke=(args:string[],grants?:string)=>spawnSync(process.execPath,[cli,"command","health/run",...mode,...args],{cwd:root,encoding:"utf8",env:{...process.env,PORT:"not-an-http-process",TEST_COMMAND_GRANTS:grants},timeout:15000});
        const ok=invoke(["--input",'{"status":"ok"}'],"health:run");assert.equal(ok.status,0,ok.stderr);assert.deepEqual(JSON.parse(ok.stdout),{status:"ok"});assert.match(ok.stderr,/disposed/);
        const denied=invoke(["--input",'{"status":"ok"}']);assert.equal(denied.status,3,denied.stderr);assert.equal(denied.stdout,"");assert.match(denied.stderr,/forbidden/);
        const spoof=invoke(["--input",'{"status":"ok"}',"--permissions","health:run"]);assert.equal(spoof.status,2);assert.equal(JSON.parse(spoof.stderr).error.code,"invalid_input");
        const invalid=invoke(["--input","{}"]);assert.equal(invalid.status,2);assert.match(invalid.stderr,/invalid_input/);
    }
});

async function interruptAt(root: string, args: string[], marker: string, failCleanup: boolean) {
    const child = spawn(process.execPath, [cli, ...args], { cwd: root, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, TEST_SLOW_SETUP: marker === "setup pending" ? "true" : "false", TEST_FAIL_CLEANUP: String(failCleanup) } });
    let stdout = "", stderr = "", sent = false;
    const completed = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", () => resolve()); });
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => {
        stderr += chunk;
        if (!sent && stderr.includes(marker)) { sent = true; child.kill("SIGTERM"); }
    });
    const force = setTimeout(() => child.kill("SIGKILL"), 15000);
    try { await completed; } finally { clearTimeout(force); }
    assert.ok(sent, stderr); assert.equal(child.signalCode, null, stderr);
    assert.equal((stderr.match(/cleanup finished/g) ?? []).length, 1, stderr);
    return { code: child.exitCode, stdout, stderr };
}

it("owns early CLI trigger shutdown and suppresses command success after cancellation during cleanup", async () => {
    const root = fixture();
    write(root, "api/+config.ts", 'import {z} from "zod"; export const schema=z.object({slow:z.boolean(),fail:z.boolean()}); export const load=(env:Readonly<Record<string,string|undefined>>)=>({slow:env.TEST_SLOW_SETUP==="true",fail:env.TEST_FAIL_CLEANUP==="true"});');
    write(root, "api/+setup.ts", `import {health} from "$modules/health/facade"; import type {SetupContext} from "./$types";
export async function setup(ctx:SetupContext) {
    ctx.onClose("test",async()=>{console.error("cleanup pending"); await new Promise(resolve=>setTimeout(resolve,100)); console.error("cleanup finished"); if(ctx.config.fail) throw new Error("cleanup failed");});
    ctx.commands({identity:{kind:"machine",id:"test",permissions:[]}});
    if(ctx.config.slow){console.error("setup pending"); await new Promise(resolve=>setTimeout(resolve,100));}
    return {health};
}`);
    write(root, "commands/health/command.ts", 'import {z} from "zod";import type {CommandHandler} from "./$types";export const input=z.object({});export const output=z.object({status:z.string()});export const timeoutMs=1000;export const handler:CommandHandler=ctx=>ctx.services.health();');
    build(root);
    for (const fail of [false, true]) {
        for (const mode of ["scheduler", "schedule-worker", "consumer"]) {
            const result = await interruptAt(root, [mode, "--out-dir", "dist"], "setup pending", fail);
            assert.equal(result.code, fail ? 1 : 0, result.stderr);
            assert.doesNotMatch(result.stderr, /Configure ctx\./, "No work starts after an early stop");
        }
        for (const target of [["--source"], ["--out-dir", "dist"]]) {
            const result = await interruptAt(root, ["command", "health", ...target, "--input", "{}"], "cleanup pending", fail);
            assert.equal(result.code, fail ? 1 : 130, result.stderr); assert.equal(result.stdout, "");
            const errors = result.stderr.trim().split("\n").filter(line => line.startsWith("{"));
            assert.equal(errors.length, 1, result.stderr);
            assert.equal(JSON.parse(errors[0]).error.code, fail ? "internal_error" : "cancelled");
        }
    }
});
