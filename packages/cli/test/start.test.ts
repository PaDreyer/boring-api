import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { resolveStartDirectory, startProject } from "@boringapi/build";

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

async function interruptEntry(root: string, entry: string, marker: string, args: string[], env: NodeJS.ProcessEnv) {
    const child = spawn(process.execPath, [entry, ...args], { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
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

function patchedCli(root: string, name: string, patch: string): string {
    write(root, `${name}.cjs`, patch);
    const entry = `${name}-entry.cjs`;
    write(root, entry, `require(${JSON.stringify(join(root, `${name}.cjs`))});require(${JSON.stringify(cli)});`);
    return join(root, entry);
}

async function assertProcessRetained(root: string, entry: string, args: string[], signalMarker: string, pendingMarker = signalMarker): Promise<string> {
    const child = spawn(process.execPath, [entry, ...args], { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PORT: "0" } });
    let output = "", sent = false;
    let observed!: () => void, failed!: (error: Error) => void;
    const pending = new Promise<void>((resolve, reject) => { observed = resolve; failed = reject; });
    const exited = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", () => resolve()); });
    const receive = (chunk: Buffer) => {
        output += chunk.toString();
        if (!sent && output.includes(signalMarker)) { sent = true; child.kill("SIGTERM"); }
        if (sent && output.includes(pendingMarker)) observed();
    };
    child.stdout.on("data", receive); child.stderr.on("data", receive);
    child.once("close", () => { if (!output.includes(pendingMarker)) failed(new Error(`Process exited before ${pendingMarker}:\n${output}`)); });
    const timeout = setTimeout(() => failed(new Error(`Process did not reach ${pendingMarker}:\n${output}`)), 5000);
    try {
        await pending;
        clearTimeout(timeout);
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(child.exitCode, null, output);
        assert.equal(child.signalCode, null, output);
    } finally {
        clearTimeout(timeout);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await exited;
    }
    assert.ok(sent, output);
    assert.equal(child.signalCode, "SIGKILL", output);
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

it("startProject returns both lifecycle owners to custom tooling", async () => {
    const root = fixture();
    build(root);
    const onError = () => {};
    const started = await startProject(root, {}, 0, onError);
    try {
        assert.ok(started.server.address());
        assert.equal(started.application.ready, true);
    } finally {
        await started.application.close();
        await started.application.closed;
    }
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

it("owns signals received during setup in every direct generated production process", async () => {
    const root = fixture();
    write(root, "api/+config.ts", 'import {z} from "zod"; export const schema=z.object({fail:z.boolean()}); export const load=(env:Readonly<Record<string,string|undefined>>)=>({fail:env.TEST_FAIL_CLEANUP==="true"});');
    write(root, "api/+setup.ts", `import {health} from "$modules/health/facade"; import type {SetupContext} from "./$types";
export async function setup(ctx:SetupContext) {
    ctx.onClose("test",async()=>{await new Promise(resolve=>setTimeout(resolve,10));console.error("cleanup finished");if(ctx.config.fail)throw new Error("cleanup failed");});
    console.error("setup pending"); await new Promise(resolve=>setTimeout(resolve,100)); return {health};
}`);
    build(root);
    const entries: [string, string[], number][] = [
        ["boring-start.cjs", [], 0], ["boring-worker.cjs", [], 0], ["boring-scheduler.cjs", [], 0],
        ["boring-schedule-worker.cjs", [], 0], ["boring-consumer.cjs", [], 0], ["boring-publisher.cjs", [], 0],
        ["boring-command.cjs", ["unused", "{}"], 130],
    ];
    for (const fail of [false, true]) for (const [file, args, stoppedCode] of entries) {
        const result = await interruptEntry(root, join(root, "dist", file), "setup pending", args, { TEST_FAIL_CLEANUP: String(fail), PORT: "0" });
        assert.equal(result.code, fail ? 1 : stoppedCode, `${file}: ${result.stderr}`);
        assert.doesNotMatch(result.stdout + result.stderr, /Listening on port|Configure ctx\.|Unknown application command/);
    }
});

it("retains a generated process after an early signal while handleless setup never settles", async () => {
    const root = fixture();
    write(root, "pending-setup.cjs", `const {BoringApi}=require("@boringapi/core");
BoringApi.prototype.createApp=async()=>{console.error("setup pending without handles");return new Promise(()=>{});};`);
    build(root);
    const child = spawn(process.execPath, ["-r", join(root, "pending-setup.cjs"), join(root, "dist/boring-start.cjs")], {
        cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PORT: "0" },
    });
    let output = "", signalled = false;
    let observed!: () => void;
    const pending = new Promise<void>(resolve => { observed = resolve; });
    const exited = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", () => resolve()); });
    const receive = (chunk: Buffer) => {
        output += chunk.toString();
        if (!signalled && output.includes("setup pending without handles")) {
            signalled = true; child.kill("SIGTERM"); observed();
        }
    };
    child.stdout.on("data", receive); child.stderr.on("data", receive);
    const observationTimeout = setTimeout(() => observed(), 5000);
    try {
        await pending; clearTimeout(observationTimeout);
        assert.ok(signalled, output);
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(child.exitCode, null, output); assert.equal(child.signalCode, null, output);
    } finally {
        clearTimeout(observationTimeout);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await exited;
    }
    assert.equal(child.signalCode, "SIGKILL", output);
});

it("treats only a signal-interrupted generated listener start as a clean stop", async () => {
    const root = fixture();
    write(root, "pending-listener.cjs", `const {BoringApi,ExecutionError}=require("@boringapi/core");
BoringApi.prototype.createApp=async()=>{let rejectListen,settle;const closed=new Promise(resolve=>{settle=resolve;});return {
    listen:()=>new Promise((_,reject)=>{rejectListen=reject;console.error("listen pending");}),
    close:async()=>{console.error("cleanup finished");rejectListen(new ExecutionError("unavailable","Application shut down while listening"));settle();},
    get closed(){return closed;}
};};`);
    build(root);
    const entry = join(root, "dist/boring-start.cjs");
    write(root, "pending-listener-entry.cjs", 'require("./pending-listener.cjs");require("./dist/boring-start.cjs");');
    const interrupted = await interruptEntry(root, join(root, "pending-listener-entry.cjs"), "listen pending", [], {});
    assert.equal(interrupted.code, 0, interrupted.stderr);
    assert.doesNotMatch(interrupted.stdout + interrupted.stderr, /Listening on port|Application shut down while listening/);

    write(root, "failed-listener.cjs", `const {BoringApi}=require("@boringapi/core");
BoringApi.prototype.createApp=async()=>{let rejectListen,settle;const closed=new Promise(resolve=>{settle=resolve;});return {
    listen:()=>new Promise((_,reject)=>{rejectListen=reject;console.error("real listener pending");}),
    close:async()=>{console.error("cleanup finished");rejectListen(Object.assign(new Error("real listener failure"),{code:"EADDRINUSE"}));settle();},
    get closed(){return closed;}
};};`);
    write(root, "failed-listener-entry.cjs", 'require("./failed-listener.cjs");require("./dist/boring-start.cjs");');
    const failed = await interruptEntry(root, join(root, "failed-listener-entry.cjs"), "real listener pending", [], {});
    assert.equal(failed.code, 1, failed.stderr);
    assert.match(failed.stderr, /real listener failure/);
});

it("owns generated HTTP runtime errors through final listener cleanup", async () => {
    const root = fixture();
    build(root);
    for (const failCleanup of [false, true]) {
        write(root, "runtime-listener.cjs", `const {BoringApi}=require("@boringapi/core");const {EventEmitter}=require("node:events");
class TestServer extends EventEmitter {address(){return {port:4321};}off(name,listener){const result=super.off(name,listener);if(name==="error")console.error("runtime listener removed");return result;}}
BoringApi.prototype.createApp=async()=>{let server,observer,settle,reject;const closed=new Promise((resolve,rejectPromise)=>{settle=resolve;reject=rejectPromise;});return {
listen:async(_port,_handler,onError)=>{observer=onError;server=new TestServer();server.on("error",observer);setImmediate(()=>{console.error("runtime error emitted");server.emit("error",new Error("listener runtime failure"));});return server;},
close:async()=>{console.error("cleanup finished");const repeated=new Error("runtime failure during close");server.emit("error",repeated);server.emit("error",repeated);server.emit("error",new Error("second runtime failure during close"));server.off("error",observer);if(${JSON.stringify(failCleanup)}){const error=new Error("runtime cleanup failure");reject(error);throw error;}settle();},
get closed(){return closed;}};};`);
        write(root, "runtime-listener-entry.cjs", 'require("./runtime-listener.cjs");require("./dist/boring-start.cjs");');
        const child = spawn(process.execPath, [join(root, "runtime-listener-entry.cjs")], {
            cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PORT: "0" },
        });
        let output = "";
        child.stdout.on("data", chunk => { output += chunk.toString(); });
        child.stderr.on("data", chunk => { output += chunk.toString(); });
        const exited = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", () => resolve()); });
        const force = setTimeout(() => child.kill("SIGKILL"), 5000);
        try { await exited; } finally { clearTimeout(force); }
        assert.equal(child.signalCode, null, output); assert.equal(child.exitCode, 1, output);
        assert.match(output, /listener runtime failure/);
        assert.match(output, /runtime failure during close/);
        assert.match(output, /second runtime failure during close/);
        assert.equal((output.match(/Error: runtime failure during close/g) ?? []).length, 1, output);
        assert.equal((output.match(/cleanup finished/g) ?? []).length, 1, output);
        assert.equal((output.match(/runtime listener removed/g) ?? []).length, 1, output);
        assert.ok(output.indexOf("cleanup finished") < output.indexOf("runtime listener removed"), output);
        if (failCleanup) {
            assert.match(output, /LifecycleError: HTTP runtime and cleanup failed/);
            assert.match(output, /runtime cleanup failure/);
        }
    }
});

it("captures generated HTTP runtime errors that arrive during signal cleanup", async () => {
    const root = fixture();
    build(root);
    for (const failCleanup of [false, true]) {
        write(root, "signal-cleanup-runtime.cjs", `const {BoringApi}=require("@boringapi/core");const {EventEmitter}=require("node:events");
class TestServer extends EventEmitter {address(){return {port:4321};}}
BoringApi.prototype.createApp=async()=>{let server,observer,settle,reject;const closed=new Promise((resolve,rejectPromise)=>{settle=resolve;reject=rejectPromise;});return {
listen:async(_port,_handler,onError)=>{observer=onError;server=new TestServer();server.on("error",observer);console.error("listener ready for signal");return server;},
close:async()=>{console.error("cleanup finished");await new Promise(resolve=>setImmediate(()=>{server.emit("error",new Error("runtime error during cleanup"));resolve();}));
server.off("error",observer);if(${JSON.stringify(failCleanup)}){const error=new Error("signal cleanup failure");reject(error);throw error;}settle();},get closed(){return closed;}};};`);
        write(root, "signal-cleanup-runtime-entry.cjs", 'require("./signal-cleanup-runtime.cjs");require("./dist/boring-start.cjs");');
        const result = await interruptEntry(root, join(root, "signal-cleanup-runtime-entry.cjs"), "listener ready for signal", [], {});
        assert.equal(result.code, 1, result.stderr);
        assert.match(result.stderr, /runtime error during cleanup/);
        if (failCleanup) {
            assert.match(result.stderr, /HTTP runtime and cleanup failed/);
            assert.match(result.stderr, /signal cleanup failure/);
        }
    }
});

it("releases generated HTTP process ownership when listener detachment throws", async () => {
    const root = fixture();
    build(root);
    write(root, "throwing-listener-off.cjs", `const {BoringApi}=require("@boringapi/core");const {EventEmitter}=require("node:events");
class TestServer extends EventEmitter {address(){return {port:4321};}off(name,listener){if(name==="error")throw new Error("listener detach failure");return super.off(name,listener);}}
BoringApi.prototype.createApp=async()=>{let server,observer,settle;const closed=new Promise(resolve=>{settle=resolve;});return {
listen:async(_port,_handler,onError)=>{observer=onError;server=new TestServer();server.on("error",observer);console.error("listener ready for signal");return server;},
close:async()=>{console.error("cleanup finished");try{server.off("error",observer);}finally{settle();}},get closed(){return closed;}};};`);
    write(root, "throwing-listener-off-entry.cjs", 'require("./throwing-listener-off.cjs");require("./dist/boring-start.cjs");');
    const result = await interruptEntry(root, join(root, "throwing-listener-off-entry.cjs"), "listener ready for signal", [], {});
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /listener detach failure/);
});

it("waits for actual settlement after generated HTTP shutdown times out", async () => {
    const root = fixture();
    write(root, "api/+setup.ts", `import {health} from "$modules/health/facade";import type {SetupContext} from "./$types";
export function setup(ctx:SetupContext){ctx.onClose("test",()=>console.error("cleanup finished"));return {health};}`);
    write(root, "api/get.ts", `import type {GetHandler} from "./$types";
export const handler:GetHandler=async ctx=>{console.error("handler waiting");await new Promise(resolve=>setTimeout(resolve,100));return ctx.services.health();};`);
    write(root, "short-shutdown.cjs", `const {BoringApi}=require("@boringapi/core");const create=BoringApi.prototype.createApp;
BoringApi.prototype.createApp=function(directory,options={}){return create.call(this,directory,{...options,shutdownGraceMs:5,shutdownTimeoutMs:20});};`);
    build(root);
    const child = spawn(process.execPath, ["-r", join(root, "short-shutdown.cjs"), join(root, "dist/boring-start.cjs")], {
        cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PORT: "0" },
    });
    let output = "", sent = false;
    const exited = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", () => resolve()); });
    let request: ReturnType<typeof httpRequest> | undefined;
    const port = new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(output)), 10000);
        const receive = (chunk: Buffer) => {
            output += chunk.toString();
            const found = /Listening on port (\d+)/.exec(output);
            if (found) { clearTimeout(timeout); resolve(Number(found[1])); }
            if (!sent && output.includes("handler waiting")) {
                sent = true; request?.destroy(); child.kill("SIGTERM");
            }
        };
        child.stdout.on("data", receive); child.stderr.on("data", receive);
    });
    const serverPort = await port;
    request = httpRequest({ host: "127.0.0.1", port: serverPort, path: "/" });
    request.on("error", () => {}); request.end();
    const force = setTimeout(() => child.kill("SIGKILL"), 15000);
    try { await exited; } finally { clearTimeout(force); }
    assert.ok(sent, output); assert.equal(child.signalCode, null, output); assert.equal(child.exitCode, 1, output);
    const cleanup = output.indexOf("cleanup finished"), timeout = output.indexOf("ShutdownTimeoutError");
    assert.ok(cleanup >= 0 && timeout > cleanup, output);
});

it("keeps a generated process alive while handleless settlement remains pending", async () => {
    const root = fixture();
    write(root, "pending-settlement.cjs", `const {BoringApi,ShutdownTimeoutError}=require("@boringapi/core");const {EventEmitter}=require("node:events");
class TestServer extends EventEmitter {address(){return {port:1};}}
BoringApi.prototype.createApp=async()=>{const running=setInterval(()=>{},1000);return {
    listen:async()=>new TestServer(),
    close:async()=>{clearInterval(running);throw new ShutdownTimeoutError();},
    get closed(){console.error("closed pending");return new Promise(()=>{});}
};};`);
    build(root);
    const child = spawn(process.execPath, ["-r", join(root, "pending-settlement.cjs"), join(root, "dist/boring-start.cjs")], {
        cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PORT: "0" },
    });
    let output = "", signalled = false;
    let pending!: () => void;
    const observed = new Promise<void>(resolve => { pending = resolve; });
    const exited = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", () => resolve()); });
    const receive = (chunk: Buffer) => {
        output += chunk.toString();
        if (!signalled && output.includes("Listening on port")) { signalled = true; child.kill("SIGTERM"); }
        if (output.includes("closed pending")) pending();
    };
    child.stdout.on("data", receive); child.stderr.on("data", receive);
    const observationTimeout = setTimeout(() => pending(), 5000);
    try {
        await observed; clearTimeout(observationTimeout);
        assert.match(output, /closed pending/);
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(child.exitCode, null, output);
        assert.equal(child.signalCode, null, output);
    } finally {
        clearTimeout(observationTimeout);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await exited;
    }
    assert.equal(child.signalCode, "SIGKILL", output);
});

it("reports both a bounded shutdown timeout and a later cleanup failure", async () => {
    const root = fixture();
    write(root, "failed-settlement.cjs", `const {BoringApi,ShutdownTimeoutError}=require("@boringapi/core");const {EventEmitter}=require("node:events");
class TestServer extends EventEmitter {address(){return {port:1};}}
BoringApi.prototype.createApp=async()=>{const running=setInterval(()=>{},1000);return {
    listen:async()=>new TestServer(),
    close:async()=>{clearInterval(running);throw new ShutdownTimeoutError();},
    get closed(){return new Promise((_,reject)=>setTimeout(()=>reject(new Error("actual cleanup failed")),25));}
};};`);
    build(root);
    const child = spawn(process.execPath, ["-r", join(root, "failed-settlement.cjs"), join(root, "dist/boring-start.cjs")], {
        cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PORT: "0" },
    });
    let output = "", signalled = false;
    const receive = (chunk: Buffer) => {
        output += chunk.toString();
        if (!signalled && output.includes("Listening on port")) { signalled = true; child.kill("SIGTERM"); }
    };
    child.stdout.on("data", receive); child.stderr.on("data", receive);
    const exited = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", () => resolve()); });
    const force = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { await exited; } finally { clearTimeout(force); }
    assert.equal(child.signalCode, null, output); assert.equal(child.exitCode, 1, output);
    assert.match(output, /LifecycleError: Shutdown wait and eventual cleanup failed/);
    assert.match(output, /ShutdownTimeoutError/);
    assert.match(output, /actual cleanup failed/);
});

it("does not duplicate the same failure from close and closed", async () => {
    const root = fixture();
    write(root, "same-settlement-failure.cjs", `const {BoringApi}=require("@boringapi/core");const {EventEmitter}=require("node:events");
class TestServer extends EventEmitter {address(){return {port:1};}}
const failure=new Error("same settlement failure");
BoringApi.prototype.createApp=async()=>{const running=setInterval(()=>{},1000);return {
    listen:async()=>new TestServer(),
    close:async()=>{clearInterval(running);throw failure;},
    get closed(){return Promise.reject(failure);}
};};`);
    build(root);
    const child = spawn(process.execPath, ["-r", join(root, "same-settlement-failure.cjs"), join(root, "dist/boring-start.cjs")], {
        cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PORT: "0" },
    });
    let output = "", signalled = false;
    const receive = (chunk: Buffer) => {
        output += chunk.toString();
        if (!signalled && output.includes("Listening on port")) { signalled = true; child.kill("SIGTERM"); }
    };
    child.stdout.on("data", receive); child.stderr.on("data", receive);
    const exited = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", () => resolve()); });
    const force = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { await exited; } finally { clearTimeout(force); }
    assert.equal(child.signalCode, null, output); assert.equal(child.exitCode, 1, output);
    assert.match(output, /same settlement failure/);
    assert.doesNotMatch(output, /Shutdown wait and eventual cleanup failed/);
});

it("preserves lifecycle causes in every generated trigger process JSON error", async () => {
    const root = fixture();
    write(root, "trigger-lifecycle-failure.cjs", `const {BoringApi,ShutdownTimeoutError}=require("@boringapi/core");
BoringApi.prototype.createApp=async()=>{let finish;const run=()=>new Promise(resolve=>{finish=resolve;console.error("operation pending");});return {
    schedule:run,work:run,command:run,
    close:async()=>{finish();throw new ShutdownTimeoutError();},
    get closed(){return new Promise((_,reject)=>setTimeout(()=>reject(new Error("actual cleanup failed")),25));}
};};`);
    build(root);
    const entries: [string, string[]][] = [
        ["boring-scheduler.cjs", []], ["boring-schedule-worker.cjs", []], ["boring-consumer.cjs", []],
        ["boring-publisher.cjs", []], ["boring-command.cjs", ["unused", "{}"]],
    ];
    for (const [entry, args] of entries) {
        const child = spawn(process.execPath, ["-r", join(root, "trigger-lifecycle-failure.cjs"), join(root, "dist", entry), ...args], {
            cwd: root, stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "", stderr = "", signalled = false;
        child.stdout.on("data", chunk => { stdout += chunk.toString(); });
        child.stderr.on("data", chunk => {
            stderr += chunk.toString();
            if (!signalled && stderr.includes("operation pending")) { signalled = true; child.kill("SIGTERM"); }
        });
        const exited = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", () => resolve()); });
        const force = setTimeout(() => child.kill("SIGKILL"), 5000);
        try { await exited; } finally { clearTimeout(force); }
        assert.ok(signalled, `${entry}: ${stderr}`); assert.equal(child.signalCode, null, `${entry}: ${stderr}`);
        assert.equal(child.exitCode, 1, `${entry}: ${stderr}`); assert.equal(stdout, "", entry);
        const lines = stderr.trim().split("\n").filter(line => line.startsWith("{"));
        assert.equal(lines.length, 1, `${entry}: ${stderr}`);
        const description = JSON.parse(lines[0]).error;
        assert.equal(description.code, "internal_error");
        assert.equal(description.message, "Shutdown wait and eventual cleanup failed");
        assert.deepEqual(description.causes.map((cause: any) => [cause.name, cause.message]), [
            ["ShutdownTimeoutError", "Shutdown timed out; resources remain owned until active executions and cleanup settle"],
            ["Error", "actual cleanup failed"],
        ]);
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

it("owns a signal that interrupts the direct CLI while HTTP listen is pending", async () => {
    const root = fixture();
    build(root);
    const entry = patchedCli(root, "cli-pending-listener", `const {BoringApi,ExecutionError}=require("@boringapi/core");
BoringApi.prototype.createApp=async()=>{let rejectListen,settle;const closed=new Promise(resolve=>{settle=resolve;});return {
listen:()=>new Promise((_,reject)=>{rejectListen=reject;console.error("direct listen pending");}),
close:async()=>{console.error("cleanup finished");rejectListen(new ExecutionError("unavailable","Application shut down while listening"));settle();},
get closed(){return closed;}};};`);
    const result = await interruptEntry(root, entry, "direct listen pending", ["start", "--out-dir", "dist", "--port", "0"], {});
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /Listening on port|Application shut down while listening/);
});

it("owns direct CLI HTTP runtime errors through application settlement", () => {
    const root = fixture();
    build(root);
    const entry = patchedCli(root, "cli-runtime-listener", `const {BoringApi}=require("@boringapi/core");const {EventEmitter}=require("node:events");
class TestServer extends EventEmitter {address(){return {port:4321};}off(name,listener){const result=super.off(name,listener);if(name==="error")console.error("runtime listener removed");return result;}}
BoringApi.prototype.createApp=async()=>{let server,observer,settle;const closed=new Promise(resolve=>{settle=resolve;});return {
listen:async(_port,_handler,onError)=>{observer=onError;server=new TestServer();server.on("error",observer);setImmediate(()=>server.emit("error",new Error("direct listener runtime failure")));return server;},
close:async()=>{console.error("cleanup finished");const repeated=new Error("direct repeated runtime failure");server.emit("error",repeated);server.emit("error",repeated);server.emit("error",new Error("direct second runtime failure"));server.off("error",observer);settle();},get closed(){return closed;}};};`);
    const result = spawnSync(process.execPath, [entry, "start", "--out-dir", "dist", "--port", "0"], {
        cwd: root, encoding: "utf8", timeout: 5000, env: { ...process.env, PORT: "0" },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /direct listener runtime failure/);
    assert.match(result.stderr, /direct repeated runtime failure/);
    assert.match(result.stderr, /direct second runtime failure/);
    assert.equal((result.stderr.match(/Error: direct repeated runtime failure/g) ?? []).length, 1, result.stderr);
    assert.equal((result.stderr.match(/cleanup finished/g) ?? []).length, 1, result.stderr);
    assert.equal((result.stderr.match(/runtime listener removed/g) ?? []).length, 1, result.stderr);
});

it("retains every direct CLI process during handleless application setup", async () => {
    const root = fixture();
    build(root);
    const entry = patchedCli(root, "cli-handleless-setup", `const {BoringApi}=require("@boringapi/core");
BoringApi.prototype.createApp=async()=>{console.error("handleless setup pending");return new Promise(()=>{});};`);
    for (const args of [
        ["start", "--out-dir", "dist", "--port", "0"],
        ["publisher", "--out-dir", "dist"],
        ["command", "unused", "--out-dir", "dist", "--input", "{}"],
    ]) await assertProcessRetained(root, entry, args, "handleless setup pending");
});

it("retains every direct CLI process through handleless eventual settlement", async () => {
    const root = fixture();
    build(root);
    const entry = patchedCli(root, "cli-handleless-settlement", `const {BoringApi,ExecutionError,ShutdownTimeoutError}=require("@boringapi/core");const {EventEmitter}=require("node:events");
class TestServer extends EventEmitter {address(){return {port:4321};}}
BoringApi.prototype.createApp=async()=>{let finish=()=>{};return {
listen:async(_port,_handler,onError)=>{const server=new TestServer();server.on("error",onError);console.error("http operation ready");return server;},
work:()=>new Promise(resolve=>{finish=resolve;console.error("worker operation ready");}),
command:(_name,_input,{signal})=>new Promise((_,reject)=>{console.error("command operation ready");signal.addEventListener("abort",()=>reject(new ExecutionError("cancelled","Command cancelled")),{once:true});}),
close:async()=>{finish();throw new ShutdownTimeoutError();},
get closed(){console.error("closed pending without handles");return new Promise(()=>{});}};};`);
    const cases: [string[], string][] = [
        [["start", "--out-dir", "dist", "--port", "0"], "http operation ready"],
        [["publisher", "--out-dir", "dist"], "worker operation ready"],
        [["command", "unused", "--out-dir", "dist", "--input", "{}"], "command operation ready"],
    ];
    for (const [args, marker] of cases) {
        const output = await assertProcessRetained(root, entry, args, marker, "closed pending without handles");
        assert.match(output, /closed pending without handles/);
    }
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
        for (const mode of ["scheduler", "schedule-worker", "consumer", "publisher"]) {
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
