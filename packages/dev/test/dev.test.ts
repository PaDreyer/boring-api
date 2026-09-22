import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { it } from "node:test";
import { analyzeProject, formatArchitectureDiagnostics } from "@boringapi/analyzer";
import { runSourceCommand, startDevServer } from "../src";

const workerEntry = join(__dirname, "../dist/worker.js");

function developmentFixture(): { root: string; api: string } {
    const root = mkdtempSync(join(tmpdir(), "boring-dev-lifecycle-"));
    const write = (name: string, content: string) => {
        const target = join(root, name); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, content);
    };
    const core = dirname(require.resolve("@boringapi/core/package.json"));
    mkdirSync(join(root, "node_modules/@boringapi"), { recursive: true });
    symlinkSync(core, join(root, "node_modules/@boringapi/core"));
    for (const name of ["zod", "@types"]) symlinkSync(join(core, "node_modules", name), join(root, "node_modules", name));
    write("tsconfig.json", JSON.stringify({ extends: "./.boring/tsconfig.json", compilerOptions: {
        strict: true, skipLibCheck: true, module: "commonjs", target: "ES2020",
    }, include: ["**/*.ts"] }));
    write("api/+setup.ts", "export const setup = () => ({});");
    const project = analyzeProject(root, "api");
    assert.equal(project.diagnostics.length, 0);
    assert.equal(formatArchitectureDiagnostics(project.architecture, root), "");
    return { root, api: join(root, "api") };
}

function patchWorker(root: string, name: string, source: string): string {
    const file = join(root, `${name}.cjs`);
    writeFileSync(file, source);
    return file;
}

function spawnWorker(root: string, api: string, patch: string) {
    return spawn(process.execPath, ["-r", patch, workerEntry, root, api, "0", "", "http"], {
        cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env },
    });
}

it("formats checked source diagnostics relative to the physical project root", async () => {
    const fixture = developmentFixture();
    const physical = realpathSync(fixture.root);
    const alias = `${physical}-alias`;
    writeFileSync(join(physical, "api/+setup.ts"), `import type {SetupContext} from "./$types";
export function setup(ctx: SetupContext) { const alias = ctx; alias.readiness("database", () => {}); return {}; }`);
    symlinkSync(physical, alias, "dir");
    const expected = (error: unknown) => {
        const message = String(error);
        assert.match(message, /api\/\+setup\.ts/);
        assert.doesNotMatch(message, /\.\.\/boring-dev-lifecycle-/);
        return true;
    };
    try {
        assert.throws(() => startDevServer(alias, "api"), expected);
        await assert.rejects(runSourceCommand(alias, "api", "missing", {}), expected);
    } finally {
        unlinkSync(alias);
        rmSync(fixture.root, { recursive: true, force: true });
    }
});

async function interruptWorker(root: string, api: string, patch: string, marker: string) {
    const child = spawnWorker(root, api, patch);
    let output = "", sent = false;
    const receive = (chunk: Buffer) => {
        output += chunk.toString();
        if (!sent && output.includes(marker)) { sent = true; child.kill("SIGTERM"); }
    };
    child.stdout.on("data", receive); child.stderr.on("data", receive);
    const exited = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", () => resolve()); });
    const force = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { await exited; } finally { clearTimeout(force); }
    assert.ok(sent, output);
    assert.equal(child.signalCode, null, output);
    return { code: child.exitCode, output };
}

async function assertWorkerRetained(root: string, api: string, patch: string, signalMarker: string, pendingMarker = signalMarker): Promise<string> {
    const child = spawnWorker(root, api, patch);
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
    child.once("close", () => { if (!output.includes(pendingMarker)) failed(new Error(`Worker exited before ${pendingMarker}:\n${output}`)); });
    const timeout = setTimeout(() => failed(new Error(`Worker did not reach ${pendingMarker}:\n${output}`)), 5000);
    try {
        await pending; clearTimeout(timeout);
        await delay(50);
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

it("owns pending listen, runtime server errors and cleanup in the development HTTP worker", async () => {
    const { root, api } = developmentFixture();
    try {
        const pending = patchWorker(root, "pending-listener", `const {BoringApi,ExecutionError}=require("@boringapi/core");
BoringApi.prototype.createApp=async()=>{let rejectListen,settle;const closed=new Promise(resolve=>{settle=resolve;});return {
listen:()=>new Promise((_,reject)=>{rejectListen=reject;console.error("dev listen pending");}),
close:async()=>{console.error("cleanup finished");rejectListen(new ExecutionError("unavailable","Application shut down while listening"));settle();},get closed(){return closed;}};};`);
        const interrupted = await interruptWorker(root, api, pending, "dev listen pending");
        assert.equal(interrupted.code, 0, interrupted.output);
        assert.equal((interrupted.output.match(/cleanup finished/g) ?? []).length, 1, interrupted.output);

        const runtime = patchWorker(root, "runtime-listener", `const {BoringApi}=require("@boringapi/core");const {EventEmitter}=require("node:events");
class TestServer extends EventEmitter {address(){return {port:4321};}off(name,listener){const result=super.off(name,listener);if(name==="error")console.error("runtime listener removed");return result;}}
BoringApi.prototype.createApp=async()=>{let server,observer,settle;const closed=new Promise(resolve=>{settle=resolve;});return {
listen:async(_port,_handler,onError)=>{observer=onError;server=new TestServer();server.on("error",observer);setImmediate(()=>server.emit("error",new Error("dev listener runtime failure")));return server;},
close:async()=>{console.error("cleanup finished");const repeated=new Error("dev repeated runtime failure");server.emit("error",repeated);server.emit("error",repeated);server.emit("error",new Error("dev second runtime failure"));server.off("error",observer);settle();},get closed(){return closed;}};};`);
        const result = spawnSync(process.execPath, ["-r", runtime, workerEntry, root, api, "0", "", "http"], {
            cwd: root, encoding: "utf8", timeout: 5000, env: { ...process.env },
        });
        assert.ifError(result.error);
        assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
        assert.match(result.stderr, /dev listener runtime failure/);
        assert.match(result.stderr, /dev repeated runtime failure/);
        assert.match(result.stderr, /dev second runtime failure/);
        assert.equal((result.stderr.match(/Error: dev repeated runtime failure/g) ?? []).length, 1, result.stderr);
        assert.equal((result.stderr.match(/cleanup finished/g) ?? []).length, 1, result.stderr);
        assert.equal((result.stderr.match(/runtime listener removed/g) ?? []).length, 1, result.stderr);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

it("retains the development worker through handleless setup and eventual settlement", async () => {
    const { root, api } = developmentFixture();
    try {
        const setup = patchWorker(root, "handleless-setup", `const {BoringApi}=require("@boringapi/core");
BoringApi.prototype.createApp=async()=>{console.error("dev handleless setup pending");return new Promise(()=>{});};`);
        await assertWorkerRetained(root, api, setup, "dev handleless setup pending");

        const settlement = patchWorker(root, "handleless-settlement", `const {BoringApi,ShutdownTimeoutError}=require("@boringapi/core");const {EventEmitter}=require("node:events");
class TestServer extends EventEmitter {address(){return {port:4321};}}
BoringApi.prototype.createApp=async()=>({listen:async(_port,_handler,onError)=>{const server=new TestServer();server.on("error",onError);console.error("dev listener ready");return server;},
close:async()=>{throw new ShutdownTimeoutError();},get closed(){console.error("dev closed pending without handles");return new Promise(()=>{});}});`);
        const output = await assertWorkerRetained(root, api, settlement, "dev listener ready", "dev closed pending without handles");
        assert.match(output, /dev closed pending without handles/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

it("drains setup and cleanup after early signals in every development trigger worker", async () => {
    const root = mkdtempSync(join(tmpdir(), "boring-dev-startup-"));
    const write = (name: string, content: string) => { const target = join(root, name); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, content); };
    const core = dirname(require.resolve("@boringapi/core/package.json"));
    mkdirSync(join(root, "node_modules/@boringapi"), { recursive: true }); symlinkSync(core, join(root, "node_modules/@boringapi/core"));
    for (const name of ["zod", "@types"]) symlinkSync(join(core, "node_modules", name), join(root, "node_modules", name));
    write("tsconfig.json", JSON.stringify({ extends: "./.boring/tsconfig.json", compilerOptions: { strict: true, skipLibCheck: true, module: "commonjs", target: "ES2020" }, include: ["**/*.ts"] }));
    write("api/+config.ts", 'import {z} from "zod"; export const schema=z.object({fail:z.boolean()}); export const load=(env:Readonly<Record<string,string|undefined>>)=>({fail:env.TEST_FAIL_CLEANUP==="true"});');
    write("api/+setup.ts", `import type {SetupContext} from "./$types";
export async function setup(ctx:SetupContext) {
    ctx.onClose("test",async()=>{await new Promise(resolve=>setTimeout(resolve,50)); console.error("cleanup finished"); if(ctx.config.fail) throw new Error("cleanup failed");});
    console.error("setup pending"); await new Promise(resolve=>setTimeout(resolve,100)); return {};
}`);
    try {
        const project = analyzeProject(root, "api");
        assert.equal(project.diagnostics.length, 0); assert.equal(formatArchitectureDiagnostics(project.architecture, root), "");
        for (const fail of [false, true]) for (const mode of ["scheduler", "schedule", "event", "publication"]) {
            const child = spawn(process.execPath, [join(__dirname, "../dist/worker.js"), root, join(root, "api"), "0", "", mode], {
                cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TEST_FAIL_CLEANUP: String(fail) },
            });
            let output = "", sent = false;
            const exited = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", () => resolve()); });
            const receive = (chunk: Buffer) => { output += chunk; if (!sent && output.includes("setup pending")) { sent = true; child.kill("SIGTERM"); } };
            child.stdout.on("data", receive); child.stderr.on("data", receive);
            const force = setTimeout(() => child.kill("SIGKILL"), 10000);
            try { await exited; } finally { clearTimeout(force); }
            assert.ok(sent, output); assert.equal(child.signalCode, null, output);
            assert.equal(child.exitCode, fail ? 1 : 0, output);
            assert.equal((output.match(/cleanup finished/g) ?? []).length, 1, output);
            assert.doesNotMatch(output, /Configure ctx\./, "No execution starts after a signal during setup");
        }
    } finally { rmSync(root, { recursive: true, force: true }); }
});

async function response(port: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
        get(`http://127.0.0.1:${port}`, res => {
            const chunks: Buffer[] = [];
            res.on("data", chunk => chunks.push(Buffer.from(chunk)));
            res.on("end", () => {
                try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
                catch (error) { reject(error); }
            });
            res.on("error", reject);
        }).on("error", reject);
    });
}

it("the development server reloads sibling modules and infra, including newly created directories", async () => {
    const repository = join(__dirname, "..");
    const root = mkdtempSync(join(tmpdir(), "boring-api-dev-"));
    const application = join(root, "app");
    const api = join(application, "http");
    mkdirSync(api, { recursive: true });
    mkdirSync(join(root, "node_modules/@boringapi"), { recursive: true });
    const core = dirname(require.resolve("@boringapi/core/package.json"));
    symlinkSync(core, join(root, "node_modules/@boringapi/core"));
    symlinkSync(join(core, "node_modules/zod"), join(root, "node_modules/zod"));
    symlinkSync(join(core, "node_modules/@types"), join(root, "node_modules/@types"));
    writeFileSync(join(root, "package.json"), '{"name":"dev-consumer","private":true}\n');
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ extends: "./.boring/tsconfig.json", compilerOptions: {
        module: "commonjs", target: "ES2020", allowJs: true,
    }, include: ["app/**/*"] }));
    // Dev must use the same project configuration as check/build, rather than
    // accidentally selecting a different tsconfig beside the API directory.
    writeFileSync(join(application, "tsconfig.json"), '{"compilerOptions":{"module":"esnext"}}');
    writeFileSync(join(api, "get.js"), 'exports.handler = () => ({ value: "initial" });\n');

    const child = spawn(process.execPath, ["-e", `
        const { startDevServer } = require(${JSON.stringify(join(repository, "dist/index.js"))});
        const server = startDevServer(process.cwd(), "app/http", 0);
        process.once("SIGTERM", () => server.close());
    `], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk.toString(); });
    child.stderr.on("data", chunk => { output += chunk.toString(); });
    child.on("error", error => { output += error.stack; });
    const ports = () => [...output.matchAll(/Listening on port (\d+)/g)].map(match => Number(match[1]));
    const nextServer = async (previous: number) => {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
            const started = ports();
            if (started.length > previous) return started[started.length - 1];
            await delay(25);
        }
        assert.fail(`Dev server did not restart:\n${output}`);
    };
    const change = async (write: () => void, expected: string) => {
        const previous = ports().length;
        write();
        assert.deepEqual(await response(await nextServer(previous)), { value: expected });
    };

    try {
        assert.deepEqual(await response(await nextServer(0)), { value: "initial" });

        const module = join(application, "modules", "orders");
        const infra = join(application, "infra");
        // Adding sibling roots alone must be detected, without any API file change.
        await change(() => {
            mkdirSync(join(module, "ports"), { recursive: true });
            writeFileSync(join(module, "ports/storage.ts"), 'export interface Store { read(): string; }');
            writeFileSync(join(module, "service.ts"), 'import type { Store } from "./ports/storage"; export const read = (store: Store) => store.read();');
            writeFileSync(join(module, "facade.ts"),
                'import type { Store } from "./ports/storage"; import { read } from "./service"; export const createOrders = (store: Store) => ({ read() { return read(store); } });');
        }, "initial");
        await change(() => {
            mkdirSync(infra);
            writeFileSync(join(infra, "store.ts"), 'export const createStore = () => ({ read() { return "stored"; } });\n');
        }, "initial");

        // Connect the new facade, then change only its dependencies.
        await change(() => {
            writeFileSync(join(api, "+setup.ts"),
                'import { createOrders } from "$modules/orders/facade"; import { createStore } from "$infra/store"; export const setup = () => ({ orders: createOrders(createStore()) });\n');
            writeFileSync(join(api, "get.js"),
                'exports.handler = ctx => ({ value: ctx.services.orders.read() });\n');
        }, "stored");

        await change(() => {
            writeFileSync(join(infra, "store.ts"), 'export const createStore = () => ({ read() { return "changed storage"; } });\n');
        }, "changed storage");
        await change(() => {
            writeFileSync(join(module, "facade.ts"),
                'import type { Store } from "./ports/storage"; import { read } from "./service"; export const createOrders = (store: Store) => ({ read() { return "facade: " + read(store); } });\n');
        }, "facade: changed storage");

        const internal = join(module, "services");
        await change(() => {
            mkdirSync(internal);
            writeFileSync(join(internal, "read.ts"), 'export const read = () => "nested";\n');
            writeFileSync(join(module, "facade.ts"),
                'import { read } from "./services/read"; import type { Store } from "./ports/storage"; export const createOrders = (_store: Store) => ({ read() { return read(); } });\n');
        }, "nested");
        await change(() => {
            writeFileSync(join(internal, "read.ts"), 'export const read = () => "nested change";\n');
        }, "nested change");

        // Recreating a watched directory must attach to its new filesystem entry.
        await change(() => {
            rmSync(internal, { recursive: true });
            mkdirSync(internal);
            writeFileSync(join(internal, "read.ts"), 'export const read = () => "recreated";\n');
        }, "recreated");
        await change(() => {
            writeFileSync(join(internal, "read.ts"), 'export const read = () => "still watched";\n');
        }, "still watched");

        const previous = ports().length;
        const currentPort = ports()[previous - 1];
        mkdirSync(join(application, "dist"));
        writeFileSync(join(application, "dist", "output.js"), "// build output\n");
        await delay(300);
        assert.equal(ports().length, previous, "Build output should not restart the server");
        assert.deepEqual(await response(currentPort), { value: "still watched" });

        // An application's custom shutdown handler must not stall future reloads.
        await change(() => {
            writeFileSync(join(api, "+setup.ts"),
                'process.on("SIGTERM", () => {}); import { createOrders } from "$modules/orders/facade"; import { createStore } from "$infra/store"; export const setup = () => ({ orders: createOrders(createStore()) });\n');
        }, "still watched");
        await change(() => {
            writeFileSync(join(internal, "read.ts"), 'export const read = () => "forced restart";\n');
        }, "forced restart");
    } finally {
        if (child.exitCode === null && child.signalCode === null) {
            const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
            child.kill("SIGTERM");
            await exited;
        }
        rmSync(root, { recursive: true, force: true });
    }
});

it("restarts a checked job worker on declaration changes and awaits application cleanup without HTTP", async () => {
    const root = mkdtempSync(join(tmpdir(), "boring-dev-jobs-"));
    const write = (file: string, content: string) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), content); };
    const core = dirname(require.resolve("@boringapi/core/package.json"));
    mkdirSync(join(root, "node_modules/@boringapi"), { recursive: true }); symlinkSync(core, join(root, "node_modules/@boringapi/core"));
    symlinkSync(join(core, "node_modules/zod"), join(root, "node_modules/zod")); symlinkSync(join(core, "node_modules/@types"), join(root, "node_modules/@types"));
    write("package.json", '{"name":"dev-jobs","private":true}');
    write("tsconfig.json", JSON.stringify({ extends: "./.boring/tsconfig.json", compilerOptions: {strict:true,skipLibCheck:true,module:"commonjs",target:"ES2020"}, include:["**/*.ts"] }));
    write("modules/health/facade.ts", 'import type {ExecutionContext} from "@boringapi/core"; export function createHealth() { return {run(ctx:ExecutionContext) {ctx.throwIfAborted(); return "ok";} }; }');
    write("infra/queue.ts", `import type {JobAdapter} from "@boringapi/core";
export function createQueue(): JobAdapter { let first = true; return {
async enqueue() {}, async renew(){return true;}, async succeed(){return true;}, async fail(){return true;},
async claim() {if(!first)return; first=false; return {id:"fixture",name:"health/check",version:1,payload:{},attempt:1,token:"fixture",origin:{identity:{kind:"machine",id:"test"},correlationId:"origin"},policy:{maxAttempts:1,retryDelayMs:10,timeoutMs:1000}};}
}; }`);
    write("api/+setup.ts", `import type {SetupContext} from "./$types"; import {createQueue} from "$infra/queue"; import {createHealth} from "$modules/health/facade";
export function setup(ctx:SetupContext) {ctx.onClose("test", async()=>{await new Promise(r=>setTimeout(r,20));console.info("worker disposed");});
ctx.jobs(createQueue(),{identity:{kind:"machine",id:"worker",permissions:[]}}); return {health:createHealth()};}`);
    const declaration = (text: string) => `import {z} from "zod"; import type {JobHandler} from "./$types";
export const payload=z.object({}); export const version=1; export const policy={maxAttempts:1,retryDelayMs:10,timeoutMs:1000};
export const handler:JobHandler=async ctx=>{ctx.services.health.run(ctx.execution);console.info(${JSON.stringify(text)});};`;
    write("jobs/health/check/job.ts", declaration("job-run-one"));
    const child = spawn(process.execPath, ["-e", `const {startDevServer}=require(${JSON.stringify(join(__dirname, "../dist"))});
const worker=startDevServer(process.cwd(),"api",0,undefined,true);process.once("SIGTERM",()=>worker.close());`], {cwd:root,stdio:["ignore","pipe","pipe"]});
    let output=""; child.stdout.on("data",chunk=>{output+=chunk;});child.stderr.on("data",chunk=>{output+=chunk;});
    const exited=new Promise<void>(resolve=>child.once("close",()=>resolve()));
    const waitFor=async(text:string)=>{const end=Date.now()+15000;while(Date.now()<end&&!output.includes(text)&&child.exitCode===null)await delay(25);assert.ok(output.includes(text),output);};
    try {
        await waitFor("job-run-one"); write("jobs/health/check/job.ts", declaration("job-run-two")); await waitFor("job-run-two");
        assert.ok(output.indexOf("worker disposed")<output.indexOf("job-run-two"));assert.doesNotMatch(output,/Listening on port/);
    } finally {
        child.kill("SIGTERM"); const force=setTimeout(()=>child.kill("SIGKILL"),5000);await exited;clearTimeout(force);rmSync(root,{recursive:true,force:true});
    }
    assert.equal(child.signalCode,null); assert.equal((output.match(/worker disposed/g)??[]).length,2);
});

it("restarts a checked event process and drains resources after declaration changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "boring-dev-event-"));
    const write = (file: string, content: string) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), content); };
    const core = dirname(require.resolve("@boringapi/core/package.json"));
    mkdirSync(join(root, "node_modules/@boringapi"), { recursive: true }); symlinkSync(core, join(root, "node_modules/@boringapi/core"));
    symlinkSync(join(core, "node_modules/zod"), join(root, "node_modules/zod")); symlinkSync(join(core, "node_modules/@types"), join(root, "node_modules/@types"));
    write("package.json", '{"name":"dev-jobs","private":true}');
    write("tsconfig.json", JSON.stringify({ extends: "./.boring/tsconfig.json", compilerOptions: {strict:true,skipLibCheck:true,module:"commonjs",target:"ES2020"}, include:["**/*.ts"] }));
    write("modules/health/facade.ts", 'import type {ExecutionContext} from "@boringapi/core"; export function createHealth() { return {run(ctx:ExecutionContext) {ctx.throwIfAborted(); return "ok";} }; }');
    write("infra/queue.ts", `import type {TriggerAdapter} from "@boringapi/core";
export function createQueue(): TriggerAdapter { let first = true; return {
async acceptEvent(event) {return {id:event.id,deliveries:[]};}, async schedule(registration) {console.info((registration.input as {value:string}).value);return [];}, async enqueue() {}, async renew(){return true;}, async succeed(){return true;}, async fail(){return true;},
async claim() {if(!first)return; first=false; return {id:"fixture",name:"@event/health/check",version:1,payload:{data:{},metadata:{id:"00000000-0000-4000-8000-000000000001",type:"health.check",version:1}},attempt:1,token:"fixture",origin:{identity:{kind:"machine",id:"test"},correlationId:"origin"},policy:{maxAttempts:1,retryDelayMs:10,timeoutMs:1000}};}
}; }`);
    write("api/+setup.ts", `import type {SetupContext} from "./$types"; import {createQueue} from "$infra/queue"; import {createHealth} from "$modules/health/facade";
export function setup(ctx:SetupContext) {ctx.onClose("test", async()=>{await new Promise(r=>setTimeout(r,20));console.info("worker disposed");});
ctx.events(createQueue(),{identity:{kind:"machine",id:"worker",permissions:[]}}); return {health:createHealth()};}`);
    const declaration = (text: string) => `import {z} from "zod"; import type {EventHandler} from "./$types";
export const event={type:"health.check",version:1} as const;
export const payload=z.object({}); export const version=1; export const policy={maxAttempts:1,retryDelayMs:10,timeoutMs:1000};
export const handler:EventHandler=async ctx=>{ctx.services.health.run(ctx.execution);console.info(${JSON.stringify(text)});};`;
    write("events/health/check/event.ts", declaration("job-run-one"));
    const child = spawn(process.execPath, ["-e", `const {startDevServer}=require(${JSON.stringify(join(__dirname, "../dist"))});
const worker=startDevServer(process.cwd(),"api",0,undefined,"event");process.once("SIGTERM",()=>worker.close());`], {cwd:root,stdio:["ignore","pipe","pipe"]});
    let output=""; child.stdout.on("data",chunk=>{output+=chunk;});child.stderr.on("data",chunk=>{output+=chunk;});
    const exited=new Promise<void>(resolve=>child.once("close",()=>resolve()));
    const waitFor=async(text:string)=>{const end=Date.now()+15000;while(Date.now()<end&&!output.includes(text)&&child.exitCode===null)await delay(25);assert.ok(output.includes(text),output);};
    try {
        await waitFor("job-run-one"); write("events/health/check/event.ts", declaration("job-run-two")); await waitFor("job-run-two");
        assert.ok(output.indexOf("worker disposed")<output.indexOf("job-run-two"));assert.doesNotMatch(output,/Listening on port/);
    } finally {
        child.kill("SIGTERM"); const force=setTimeout(()=>child.kill("SIGKILL"),5000);await exited;clearTimeout(force);rmSync(root,{recursive:true,force:true});
    }
    assert.equal(child.signalCode,null); assert.equal((output.match(/worker disposed/g)??[]).length,2);
});

it("restarts a checked schedule process and drains resources after declaration changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "boring-dev-schedule-"));
    const write = (file: string, content: string) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), content); };
    const core = dirname(require.resolve("@boringapi/core/package.json"));
    mkdirSync(join(root, "node_modules/@boringapi"), { recursive: true }); symlinkSync(core, join(root, "node_modules/@boringapi/core"));
    symlinkSync(join(core, "node_modules/zod"), join(root, "node_modules/zod")); symlinkSync(join(core, "node_modules/@types"), join(root, "node_modules/@types"));
    write("package.json", '{"name":"dev-jobs","private":true}');
    write("tsconfig.json", JSON.stringify({ extends: "./.boring/tsconfig.json", compilerOptions: {strict:true,skipLibCheck:true,module:"commonjs",target:"ES2020"}, include:["**/*.ts"] }));
    write("modules/health/facade.ts", 'import type {ExecutionContext} from "@boringapi/core"; export function createHealth() { return {run(ctx:ExecutionContext) {ctx.throwIfAborted(); return "ok";} }; }');
    write("infra/queue.ts", `import type {TriggerAdapter} from "@boringapi/core";
export function createQueue(): TriggerAdapter { let first = true; return {
async acceptEvent(event) {return {id:event.id,deliveries:[]};}, async schedule(registration) {console.info((registration.input as {value:string}).value);return [];}, async enqueue() {}, async renew(){return true;}, async succeed(){return true;}, async fail(){return true;},
async claim() {if(!first)return; first=false; return {id:"fixture",name:"@schedule/health/check",version:1,payload:{data:{},metadata:{id:"00000000-0000-4000-8000-000000000001",scheduledAt:0}},attempt:1,token:"fixture",origin:{identity:{kind:"machine",id:"test"},correlationId:"origin"},policy:{maxAttempts:1,retryDelayMs:10,timeoutMs:1000}};}
}; }`);
    write("api/+setup.ts", `import type {SetupContext} from "./$types"; import {createQueue} from "$infra/queue"; import {createHealth} from "$modules/health/facade";
export function setup(ctx:SetupContext) {ctx.onClose("test", async()=>{await new Promise(r=>setTimeout(r,20));console.info("worker disposed");});
ctx.schedules(createQueue(),{identity:{kind:"machine",id:"worker",permissions:[]}}); return {health:createHealth()};}`);
    const declaration = (text: string) => `import {z} from "zod"; import type {ScheduleHandler} from "./$types";
export const input={value:${JSON.stringify(text)}}; export const timing={startAt:0,everyMs:1000,missed:"latest",maxCatchUp:1,overlap:"skip"} as const;
export const payload=z.object({}); export const version=1; export const policy={maxAttempts:1,retryDelayMs:10,timeoutMs:1000};
export const handler:ScheduleHandler=async ctx=>{ctx.services.health.run(ctx.execution);console.info(${JSON.stringify(text)});};`;
    write("schedules/health/check/schedule.ts", declaration("job-run-one"));
    const child = spawn(process.execPath, ["-e", `const {startDevServer}=require(${JSON.stringify(join(__dirname, "../dist"))});
const worker=startDevServer(process.cwd(),"api",0,undefined,"schedule");process.once("SIGTERM",()=>worker.close());`], {cwd:root,stdio:["ignore","pipe","pipe"]});
    let output=""; child.stdout.on("data",chunk=>{output+=chunk;});child.stderr.on("data",chunk=>{output+=chunk;});
    const exited=new Promise<void>(resolve=>child.once("close",()=>resolve()));
    const waitFor=async(text:string)=>{const end=Date.now()+15000;while(Date.now()<end&&!output.includes(text)&&child.exitCode===null)await delay(25);assert.ok(output.includes(text),output);};
    try {
        await waitFor("job-run-one"); write("schedules/health/check/schedule.ts", declaration("job-run-two")); await waitFor("job-run-two");
        assert.ok(output.indexOf("worker disposed")<output.indexOf("job-run-two"));assert.doesNotMatch(output,/Listening on port/);
    } finally {
        child.kill("SIGTERM"); const force=setTimeout(()=>child.kill("SIGKILL"),5000);await exited;clearTimeout(force);rmSync(root,{recursive:true,force:true});
    }
    assert.equal(child.signalCode,null); assert.equal((output.match(/worker disposed/g)??[]).length,2);
});

it("restarts a checked scheduler process and drains resources after declaration changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "boring-dev-scheduler-"));
    const write = (file: string, content: string) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), content); };
    const core = dirname(require.resolve("@boringapi/core/package.json"));
    mkdirSync(join(root, "node_modules/@boringapi"), { recursive: true }); symlinkSync(core, join(root, "node_modules/@boringapi/core"));
    symlinkSync(join(core, "node_modules/zod"), join(root, "node_modules/zod")); symlinkSync(join(core, "node_modules/@types"), join(root, "node_modules/@types"));
    write("package.json", '{"name":"dev-jobs","private":true}');
    write("tsconfig.json", JSON.stringify({ extends: "./.boring/tsconfig.json", compilerOptions: {strict:true,skipLibCheck:true,module:"commonjs",target:"ES2020"}, include:["**/*.ts"] }));
    write("modules/health/facade.ts", 'import type {ExecutionContext} from "@boringapi/core"; export function createHealth() { return {run(ctx:ExecutionContext) {ctx.throwIfAborted(); return "ok";} }; }');
    write("infra/queue.ts", `import type {TriggerAdapter} from "@boringapi/core";
export function createQueue(): TriggerAdapter { let first = true; return {
async acceptEvent(event) {return {id:event.id,deliveries:[]};}, async schedule(registration) {console.info((registration.input as {value:string}).value);return [];}, async enqueue() {}, async renew(){return true;}, async succeed(){return true;}, async fail(){return true;},
async claim() {if(!first)return; first=false; return {id:"fixture",name:"@schedule/health/check",version:1,payload:{data:{},metadata:{id:"00000000-0000-4000-8000-000000000001",scheduledAt:0}},attempt:1,token:"fixture",origin:{identity:{kind:"machine",id:"test"},correlationId:"origin"},policy:{maxAttempts:1,retryDelayMs:10,timeoutMs:1000}};}
}; }`);
    write("api/+setup.ts", `import type {SetupContext} from "./$types"; import {createQueue} from "$infra/queue"; import {createHealth} from "$modules/health/facade";
export function setup(ctx:SetupContext) {ctx.onClose("test", async()=>{await new Promise(r=>setTimeout(r,20));console.info("worker disposed");});
ctx.schedules(createQueue(),{identity:{kind:"machine",id:"worker",permissions:[]}}); return {health:createHealth()};}`);
    const declaration = (text: string) => `import {z} from "zod"; import type {ScheduleHandler} from "./$types";
export const input={value:${JSON.stringify(text)}}; export const timing={startAt:0,everyMs:1000,missed:"latest",maxCatchUp:1,overlap:"skip"} as const;
export const payload=z.object({}); export const version=1; export const policy={maxAttempts:1,retryDelayMs:10,timeoutMs:1000};
export const handler:ScheduleHandler=async ctx=>{ctx.services.health.run(ctx.execution);console.info(${JSON.stringify(text)});};`;
    write("schedules/health/check/schedule.ts", declaration("job-run-one"));
    const child = spawn(process.execPath, ["-e", `const {startDevServer}=require(${JSON.stringify(join(__dirname, "../dist"))});
const worker=startDevServer(process.cwd(),"api",0,undefined,"scheduler");process.once("SIGTERM",()=>worker.close());`], {cwd:root,stdio:["ignore","pipe","pipe"]});
    let output=""; child.stdout.on("data",chunk=>{output+=chunk;});child.stderr.on("data",chunk=>{output+=chunk;});
    const exited=new Promise<void>(resolve=>child.once("close",()=>resolve()));
    const waitFor=async(text:string)=>{const end=Date.now()+15000;while(Date.now()<end&&!output.includes(text)&&child.exitCode===null)await delay(25);assert.ok(output.includes(text),output);};
    try {
        await waitFor("job-run-one"); write("schedules/health/check/schedule.ts", declaration("job-run-two")); await waitFor("job-run-two");
        assert.ok(output.indexOf("worker disposed")<output.indexOf("job-run-two"));assert.doesNotMatch(output,/Listening on port/);
    } finally {
        child.kill("SIGTERM"); const force=setTimeout(()=>child.kill("SIGKILL"),5000);await exited;clearTimeout(force);rmSync(root,{recursive:true,force:true});
    }
    assert.equal(child.signalCode,null); assert.equal((output.match(/worker disposed/g)??[]).length,2);
});
