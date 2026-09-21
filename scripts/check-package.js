const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const { tmpdir } = require("node:os");
const { dirname, join, relative, resolve, sep } = require("node:path");

const { packages: workspacePackages } = require("./workspaces");
const expectedPackages = workspacePackages();

// Install actual tarballs outside the workspace, where hoisting cannot hide missing dependencies.
assert.equal(process.argv.length - 2, expectedPackages.length, "Pass one tarball for each publishable workspace package.");
const temporary = mkdtempSync(join(tmpdir(), "boring-package-check-"));
const env = { ...process.env };
delete env.NODE_PATH;
delete env.NODE_OPTIONS;
function run(command, args, cwd = temporary) {
    const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
}
function tar(...args) { return run("tar", args); }
function json(file, value) { writeFileSync(file, JSON.stringify(value, null, 2) + "\n"); }
const documents = readdirSync(join(__dirname, "../docs")).filter(name => name.endsWith(".md")).map(name => `docs/${name}`);
function prose(file) { return readFileSync(file, "utf8").replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, ""); }
function anchors(file) {
    const counts = new Map();
    return [...prose(file).matchAll(/^#{1,6}\s+(.+)$/gm)].map(([, title]) => {
        const slug = title.toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, "").replace(/ /g, "-");
        const count = counts.get(slug) || 0;
        counts.set(slug, count + 1);
        return count ? `${slug}-${count}` : slug;
    });
}
function verifyArchive(archive) {
    const entries = tar("-tzf", archive).trim().split("\n");
    for (const entry of entries) {
        assert.ok(entry.startsWith("package/") && !entry.split("/").includes(".."), `Invalid archive path: ${entry}`);
        assert.match(entry, /^package\/(?:package\.json|README\.md|LICENSE|bin\/boring\.cjs|dist\/.*|docs\/.*)$/, `Unexpected package file: ${entry}`);
    }
    const manifest = JSON.parse(tar("-xOf", archive, "package/package.json"));
    const expected = expectedPackages.find(entry => entry.manifest.name === manifest.name)?.manifest;
    assert.ok(expected, `Unexpected package: ${manifest.name}`);
    assert.equal(manifest.version, expected.version);
    assert.deepEqual(manifest.exports, expected.exports);
    for (const [dependency, version] of Object.entries(expected.dependencies || {})) {
        const workspace = expectedPackages.find(entry => entry.manifest.name === dependency);
        assert.equal(manifest.dependencies[dependency], workspace ? `^${workspace.manifest.version}` : version,
            `${manifest.name}: incorrect dependency ${dependency}`);
    }
    const core = manifest.name === "@boringapi/core";
    const cli = manifest.name === "@boringapi/cli";
    const required = cli ? ["bin/boring.cjs", "dist/cli.js"] : ["dist/index.js", "dist/index.d.ts"];
    for (const file of ["package.json", "README.md", "LICENSE", ...required, ...documents]) {
        assert.ok(entries.includes(`package/${file}`), `${manifest.name}: missing ${file}`);
    }
    for (const entry of Object.values(manifest.exports)) {
        for (const file of typeof entry === "string" ? [entry] : Object.values(entry)) {
            assert.ok(entries.includes(`package/${file.replace(/^\.\//, "")}`), `${manifest.name}: missing export ${file}`);
        }
    }
    if (core) {
        for (const dependency of ["typescript", "ts-node", ...expectedPackages.filter(p => p.manifest.name !== manifest.name).map(p => p.manifest.name)]) {
            for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
                assert.equal(manifest[field]?.[dependency], undefined, `Core has a runtime dependency on ${dependency}`);
            }
        }
        for (const file of ["dist/cli.js", "dist/register.js", "dist/core/compiler.js", "dist/core/typegen.js"]) {
            assert.ok(!entries.includes(`package/${file}`), `Core contains tooling: ${file}`);
        }
    }
    if (cli) {
        assert.equal(manifest.bin.boring, "./bin/boring.cjs");
        assert.equal(manifest.dependencies.typescript, undefined);
        assert.equal(manifest.dependencies["ts-node"], undefined);
        for (const entry of entries.filter(file => file.startsWith("package/dist/"))) {
            assert.match(entry, /^package\/dist\/cli\.(?:js(?:\.map)?|d\.ts)$/, `CLI contains a tool implementation: ${entry}`);
        }
    } else assert.equal(manifest.bin, undefined);
    if (manifest.name === "@boringapi/compiler") assert.ok(manifest.dependencies.typescript && manifest.dependencies["ts-node"]);
    for (const lifecycle of ["prepare", "preinstall", "install", "postinstall"]) {
        assert.equal(manifest.scripts?.[lifecycle], undefined, `${manifest.name} must not compile during installation`);
    }
    const extracted = join(temporary, manifest.name.split("/")[1]);
    mkdirSync(extracted);
    tar("-xzf", archive, "-C", extracted);
    const installed = join(extracted, "package");
    for (const document of ["README.md", ...documents]) {
        const file = join(installed, document);
        for (const [, href] of prose(file).matchAll(/\[[^\]\n]+\]\(([^\s)]+)\)/g)) {
            if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
            const [path, fragment] = href.split("#");
            const target = path ? resolve(dirname(file), decodeURIComponent(path)) : file;
            const within = relative(installed, target);
            assert.ok(!within.startsWith(`..${sep}`) && within !== "..", `${document}: link leaves package: ${href}`);
            assert.ok(existsSync(target), `${document}: missing link target: ${href}`);
            if (fragment) assert.ok(anchors(target).includes(decodeURIComponent(fragment)), `${document}: missing heading: ${href}`);
        }
    }
    return { manifest, archive };
}
async function serves(directory, entry) {
    const child = spawn(process.execPath, [entry], { cwd: directory, env: { ...env, PORT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise(resolve => child.once("close", resolve));
    let output = "";
    try {
        const port = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`Startup timed out:\n${output}`)), 10000);
            const finish = (error, port) => { clearTimeout(timer); error ? reject(error) : resolve(port); };
            child.once("error", error => finish(error));
            child.once("exit", code => finish(new Error(`Server exited ${code}:\n${output}`)));
            const receive = chunk => {
                output += chunk.toString();
                const match = /Listening on port (\d+)/.exec(output);
                if (match) finish(undefined, Number(match[1]));
            };
            child.stdout.on("data", receive);
            child.stderr.on("data", receive);
        });
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { status: "ok" });
    } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        const force = setTimeout(() => child.kill("SIGKILL"), 5000);
        await exited;
        clearTimeout(force);
        assert.equal(child.exitCode, 0, `Graceful shutdown failed: ${output}`);
        assert.equal(child.signalCode, null);
        assert.match(output, /resource disposed/);
    }
}
async function main() {
    let closeDatabase = async () => {};
    try {
        const packages = process.argv.slice(2).map(file => verifyArchive(resolve(file)));
        const core = packages.find(p => p.manifest.name === "@boringapi/core");
        const cli = packages.find(p => p.manifest.name === "@boringapi/cli");
        assert.equal(new Set(packages.map(p => p.manifest.name)).size, expectedPackages.length, "Duplicate or missing archive");
        assert.ok(core && cli);
        for (const entry of packages) assert.equal(entry.manifest.version, core.manifest.version, "Workspace packages share a release version");
        const consumer = join(temporary, "consumer");
        mkdirSync(consumer);
        // Exercise init's promotion of preinstalled runtime packages out of devDependencies.
        json(join(consumer, "package.json"), { name: "package-check", private: true,
            devDependencies: { ...Object.fromEntries(packages.map(p => [p.manifest.name, `file:${p.archive}`])),
                zod: core.manifest.peerDependencies.zod } });
        run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], consumer);
        const consumerRequire = createRequire(join(consumer, "package.json"));
        const executable = join(dirname(consumerRequire.resolve("@boringapi/cli/package.json")), cli.manifest.bin.boring);
        run(process.execPath, [executable, "init", ".", "--dir", "src/http"], consumer);
        const initialized = JSON.parse(readFileSync(join(consumer, "package.json"), "utf8"));
        for (const name of ["@boringapi/core", "zod"]) {
            assert.ok(initialized.dependencies[name], `${name} must be a runtime dependency after init`);
            assert.equal(initialized.devDependencies[name], undefined);
        }
        const jobsPackage = packages.find(p => p.manifest.name === "@boringapi/jobs-postgres");
        initialized.dependencies["@boringapi/jobs-postgres"] = initialized.devDependencies["@boringapi/jobs-postgres"];
        delete initialized.devDependencies["@boringapi/jobs-postgres"];
        initialized.dependencies.pg = jobsPackage.manifest.dependencies.pg;
        initialized.devDependencies["@types/pg"] = jobsPackage.manifest.devDependencies["@types/pg"];
        json(join(consumer, "package.json"), initialized);
        assert.ok(env.BORING_TEST_DATABASE_URL, "Set BORING_TEST_DATABASE_URL for the required compiled durable-worker verification");
        const { Pool } = consumerRequire("pg");
        const admin = new Pool({ connectionString: env.BORING_TEST_DATABASE_URL });
        const schema = "packed_jobs_" + require("node:crypto").randomUUID().replace(/-/g, "");
        await admin.query(`CREATE SCHEMA ${schema}`);
        const databaseUrl = new URL(env.BORING_TEST_DATABASE_URL);
        databaseUrl.searchParams.set("options", `-csearch_path=${schema}`);
        env.DATABASE_URL = databaseUrl.toString();
        const database = new Pool({ connectionString: env.DATABASE_URL });
        closeDatabase = async () => { await database.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); };
        // Explicit migration action, before either HTTP or worker startup.
        await database.query(consumerRequire("@boringapi/jobs-postgres").jobMigration.sql);
        await database.query(consumerRequire("@boringapi/jobs-postgres").triggerMigration.sql);
        run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], consumer);
        writeFileSync(join(consumer, "src/infra/lifetime.ts"), `export function acquire(fail: boolean) {
    return { close() { console.info("resource disposed"); if (fail) throw new Error("cleanup failed"); } };
}
`);
        mkdirSync(join(consumer, "src/modules/dispatch/ports"), { recursive: true });
        mkdirSync(join(consumer, "src/jobs/health/check"), { recursive: true });
        writeFileSync(join(consumer, "src/modules/dispatch/ports/queue.ts"), `import type { ExecutionContext, JobReceipt } from "@boringapi/core";
export interface Queue { enqueue(execution: ExecutionContext, input: {}): Promise<JobReceipt>; }
`);
        writeFileSync(join(consumer, "src/modules/dispatch/facade.ts"), `import type { ExecutionContext } from "@boringapi/core";
import type { Queue } from "./ports/queue";
export function createDispatch(queue: Queue) { return { enqueue(ctx: ExecutionContext, input: {}) { return queue.enqueue(ctx, input); } }; }
`);
        writeFileSync(join(consumer, "src/infra/jobs.ts"), `import { Pool } from "pg";
import { createPostgresJobs } from "@boringapi/jobs-postgres";
export function createQueue(url: string) { const pool = new Pool({ connectionString: url });
    return { adapter: createPostgresJobs(pool), close: () => pool.end() }; }
`);
        writeFileSync(join(consumer, "src/http/+config.ts"), `import { z } from "zod";
import type { ConfigEnvironment } from "./$types";
export const schema = z.object({ databaseUrl: z.string(), slowSetup: z.boolean(), failCleanup: z.boolean() });
export const load = (env: ConfigEnvironment) => ({ databaseUrl: env.DATABASE_URL, slowSetup: env.BORING_CHECK_SLOW_SETUP === "true", failCleanup: env.BORING_CHECK_FAIL_CLEANUP === "true" });
`);
        writeFileSync(join(consumer, "src/jobs/health/check/job.ts"), `import { z } from "zod";
import type { JobHandler } from "./$types";
export const payload = z.object({}); export const version = 1;
export const policy = { maxAttempts: 3, retryDelayMs: 10, timeoutMs: 1000 } as const;
export const handler: JobHandler = async ctx => { await ctx.services.health.get(ctx.execution); console.info("compiled job executed"); };
`);
        writeFileSync(join(consumer, "src/http/+setup.ts"), `import type { SetupContext } from "./$types";
import { createHealth } from "$modules/health/facade";
import { acquire } from "$infra/lifetime";
import { createQueue } from "$infra/jobs";
import { createDispatch } from "$modules/dispatch/facade";
export async function setup(ctx: SetupContext) {
    const resource = acquire(ctx.config.failCleanup);
    ctx.onClose("fixture", () => resource.close());
    const queue = createQueue(ctx.config.databaseUrl);
    ctx.onClose("queue", () => queue.close());
    const jobs = ctx.jobs(queue.adapter, {identity:{kind:"machine",id:"packed-worker",permissions:[]}});
    ctx.schedules(queue.adapter, {identity:{kind:"machine",id:"packed-scheduler",permissions:[]}});
    ctx.events(queue.adapter, {identity:{kind:"machine",id:"packed-consumer",permissions:[]}});
    ctx.commands({identity:{kind:"machine",id:"packed-command",permissions:[]}});
    if (ctx.config.slowSetup) { console.error("setup waiting"); await new Promise(resolve => setTimeout(resolve, 200)); }
    return { health: createHealth(), dispatch: createDispatch(jobs.for("health/check")) };
}
`);
        for (const kind of ["schedule", "event", "command"]) {
            mkdirSync(join(consumer, `src/${kind}s/health/check`), { recursive: true });
            const title = kind[0].toUpperCase() + kind.slice(1);
            writeFileSync(join(consumer, `src/${kind}s/health/check/${kind}.ts`), `import {z} from "zod";
import type {${title}Handler} from "./$types";
${kind === "command" ? 'export const input=z.object({wait:z.boolean().optional()}); export const output=z.object({status:z.literal("ok")}); export const timeoutMs=30000;' : 'export const payload=z.object({}); export const version=1; export const policy={maxAttempts:3,retryDelayMs:10,timeoutMs:1000} as const;'}
${kind === "schedule" ? 'export const input={}; export const timing={startAt:0,everyMs:3600000,missed:"latest",maxCatchUp:1,overlap:"skip"} as const;' : kind === "event" ? 'export const event={type:"health.requested",version:1} as const;' : ''}
export const handler:${title}Handler=async ctx=> {
${kind === "command" ? 'if(ctx.input.wait) {console.error("command waiting"); await new Promise<void>((resolve,reject)=>ctx.execution.signal.addEventListener("abort",()=>reject(ctx.execution.signal.reason),{once:true}));} return ctx.services.health.get(ctx.execution);' : 'await ctx.services.health.get(ctx.execution);'}
};
`);
        }
        writeFileSync(join(consumer, "src/server.ts"), `import { join } from "path";
import { BoringApi } from "@boringapi/core";
async function main() {
    const app = await new BoringApi().createApp(join(__dirname, "http"));
    const server = await app.listen(0);
    console.info("Listening on port " + (server.address() as import("net").AddressInfo).port);
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
        void app.close().catch(error => { console.error(error); process.exitCode = 1; });
    });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
`);
        const consumerConfig = JSON.parse(readFileSync(join(consumer, "tsconfig.json"), "utf8"));
        consumerConfig.include.push("src/server.ts");
        json(join(consumer, "tsconfig.json"), consumerConfig);
        run(process.execPath, [executable, "build", "src/http"], consumer);
        const publicApis = {
            "@boringapi/jobs-postgres": "createPostgresJobs",
            "@boringapi/compiler": "readConfiguration",
            "@boringapi/compiler/register": "registerTypeScript",
            "@boringapi/typegen": "generateTypes",
            "@boringapi/analyzer": "analyzeProject",
            "@boringapi/build": "buildProject",
            "@boringapi/scaffold": "initializeProject",
            "@boringapi/dev": "startDevServer",
        };
        for (const [name, method] of Object.entries(publicApis)) assert.equal(typeof consumerRequire(name)[method], "function", name);
        // Public declaration dependencies must also resolve outside the workspace.
        writeFileSync(join(consumer, "tool-apis.ts"), Object.entries(publicApis).map(([name, method]) =>
            `import { ${method} } from "${name}"; void ${method};`).join("\n") + `
import type { Application, ScheduleContext, EventContext, CommandContext, TriggerAdapter, ScheduleTiming, EventReceipt } from "@boringapi/core";
import { commandFailure, validateScheduleTiming } from "@boringapi/core";
import { triggerMigration } from "@boringapi/jobs-postgres";
import { addTrigger } from "@boringapi/scaffold";
import { runSourceCommand } from "@boringapi/dev";
declare const app: Application; declare const adapter: TriggerAdapter;
declare const schedule: ScheduleContext<{},{}>; declare const event: EventContext<{},{}>; declare const command: CommandContext<{},{}>;
declare const timing: ScheduleTiming; declare const receipt: EventReceipt;
void [app.command, app.acceptEvent, app.tick, app.schedule, adapter.acceptEvent, adapter.schedule, schedule.occurrence, event.event, command.input, receipt.deliveries];
void [commandFailure, validateScheduleTiming, timing, triggerMigration, addTrigger, runSourceCommand];
`);
        const compilerRequire = createRequire(consumerRequire.resolve("@boringapi/compiler/package.json"));
        run(process.execPath, [compilerRequire.resolve("typescript/bin/tsc"), "--noEmit", "--strict", "--esModuleInterop",
            "--target", "es2020", "--module", "commonjs", "--types", "node", "tool-apis.ts"], consumer);
        // Relocate the artifact into a fresh deployment containing no source or workspace links.
        const deployment = join(temporary, "deployment");
        mkdirSync(deployment);
        cpSync(join(consumer, "package.json"), join(deployment, "package.json"));
        cpSync(join(consumer, "package-lock.json"), join(deployment, "package-lock.json"));
        renameSync(join(consumer, "dist"), join(deployment, "artifact"));
        run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], deployment);
        rmSync(consumer, { recursive: true });
        const productionRequire = createRequire(join(deployment, "package.json"));
        for (const name of ["typescript", "ts-node", ...packages.filter(p => p !== core && p !== jobsPackage).map(p => p.manifest.name)]) {
            assert.throws(() => productionRequire.resolve(name), { code: "MODULE_NOT_FOUND" }, `${name} must not be installed in production`);
        }
        assert.equal(typeof productionRequire("@boringapi/core").BoringApi, "function");
        assert.equal(typeof productionRequire("@boringapi/core/client").createClient, "function");
        assert.equal(typeof productionRequire("@boringapi/core/conventions").scanApi, "function");
        assert.ok(existsSync(productionRequire.resolve("@boringapi/core/agent-guide")));
        await serves(deployment, join(deployment, "artifact/boring-start.cjs"));
        await serves(deployment, join(deployment, "artifact/server.js"));
        const controlled = run(process.execPath, ["-e", `
const assert = require("node:assert/strict");
const { BoringApi } = require("@boringapi/core");
const { readHealth } = require("./artifact/executions/health.js");
(async () => {
    const app = await new BoringApi().createApp(require("node:path").resolve("artifact/http"), { env: process.env });
    try {
        assert.deepEqual(await readHealth(app, { kind: "machine", id: "package-check", permissions: [] }), { status: "ok" });
        await assert.rejects(app.execute({ identity: { kind: "machine", id: "deadline", permissions: [] }, timeoutMs: 10 }, ({ execution }) =>
            new Promise((_resolve, reject) => execution.signal.addEventListener("abort", () => reject(execution.signal.reason), { once: true }))),
            { code: "deadline" });
        const starting = assert.rejects(app.listen(0), { code: "unavailable" });
        await app.close();
        await starting;
    } finally { await app.close(); }
    assert.equal(app.state, "closed");
    await assert.rejects(readHealth(app, { kind: "machine", id: "closed", permissions: [] }), { code: "unavailable" });
    console.info("controlled lifecycle verified");
})().catch(error => { console.error(error); process.exitCode = 1; });
`], deployment);
        assert.match(controlled, /resource disposed/);
        assert.match(controlled, /controlled lifecycle verified/);

        const enqueueOutput = run(process.execPath, ["-e", `
const {BoringApi} = require("@boringapi/core");
(async () => { const app=await new BoringApi().createApp(require("node:path").resolve("artifact/http"));
try { const receipt=await app.execute({identity:{kind:"machine",id:"producer",permissions:[]}}, ctx => ctx.services.dispatch.enqueue(ctx.execution, {})); console.log("receipt="+receipt.id); }
finally {await app.close();} })().catch(e=>{console.error(e);process.exitCode=1;});
`], deployment);
        const jobId = /receipt=([a-f0-9-]+)/.exec(enqueueOutput)?.[1]; assert.ok(jobId);
        const worker = spawn(process.execPath, [join(deployment, "artifact/boring-worker.cjs")], {cwd:deployment,env,stdio:["ignore","pipe","pipe"]});
        let workerOutput = "";
        worker.stdout.on("data", chunk => {workerOutput += chunk;}); worker.stderr.on("data", chunk => {workerOutput += chunk;});
        const workerExited = new Promise(resolve => worker.once("close", resolve));
        try {
            const end = Date.now() + 10000;
            let completed = false;
            while (Date.now() < end) {
                const row = (await database.query("SELECT status FROM boring_jobs WHERE id=$1", [jobId])).rows[0];
                if (row?.status === "succeeded") { completed = true; break; }
                if (worker.exitCode !== null) break;
                await new Promise(resolve => setTimeout(resolve, 30));
            }
            assert.ok(completed, `Compiled worker did not complete: ${workerOutput}`);
        } finally {
            worker.kill("SIGTERM"); const force = setTimeout(() => worker.kill("SIGKILL"), 5000);
            await workerExited; clearTimeout(force);
        }
        assert.equal(worker.exitCode, 0, workerOutput); assert.equal(worker.signalCode, null);
        assert.match(workerOutput, /compiled job executed/); assert.match(workerOutput, /resource disposed/);
        const eventOutput = run(process.execPath, ["-e", `
const {BoringApi}=require("@boringapi/core");
(async()=>{const app=await new BoringApi().createApp(require("node:path").resolve("artifact/http"));
try {const receipt=await app.acceptEvent({identity:{kind:"machine",id:"ingress",permissions:[]}}, {id:require("node:crypto").randomUUID(),type:"health.requested",version:1,payload:{}});console.log("delivery="+receipt.deliveries[0]);} finally {await app.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
`], deployment);
        const eventId = /delivery=([a-f0-9-]+)/.exec(eventOutput)?.[1]; assert.ok(eventId);
        async function processUntil(filename, done, expectedCode = 0, args = []) {
            const child = spawn(process.execPath, [join(deployment, `artifact/${filename}`), ...args], {cwd:deployment,env,stdio:["ignore","pipe","pipe"]});
            let output="", stderr="";child.stdout.on("data", chunk=>{output+=chunk;});child.stderr.on("data",chunk=>{output+=chunk;stderr+=chunk;});
            const exited = new Promise(resolve=>child.once("close",resolve));
            try {
                const end=Date.now()+15000; let completed=false;
                while(Date.now()<end && child.exitCode===null) { if(await done(output)){completed=true;break;} await new Promise(resolve=>setTimeout(resolve,30)); }
                assert.ok(completed, `${filename} did not reach expected state: ${output}`);
            } finally {child.kill("SIGTERM");const force=setTimeout(()=>child.kill("SIGKILL"),12000);await exited;clearTimeout(force);}
            assert.equal(child.signalCode,null,output);assert.equal(child.exitCode,expectedCode,output);assert.match(output,/resource disposed/);
            return stderr;
        }
        await processUntil("boring-consumer.cjs", async()=> (await database.query("SELECT status FROM boring_jobs WHERE id=$1",[eventId])).rows[0]?.status === "succeeded");
        await processUntil("boring-scheduler.cjs", async()=> (await database.query("SELECT count(*)::int n FROM boring_jobs WHERE name='@schedule/health/check'")).rows[0].n === 1);
        await processUntil("boring-schedule-worker.cjs", async()=> (await database.query("SELECT count(*)::int n FROM boring_jobs WHERE name='@schedule/health/check' AND status='succeeded'")).rows[0].n === 1);
        const commandOutput = run(process.execPath, [join(deployment,"artifact/boring-command.cjs"),"health/check","{}"], deployment);
        assert.match(commandOutput,/\{"status":"ok"\}/);assert.match(commandOutput,/resource disposed/);
        for (const [name,input,code] of [["absent","{}","unknown_command"],["health/check","{","invalid_input"],["health/check",'{"wait":1}',"invalid_input"]]) {
            const result=spawnSync(process.execPath,[join(deployment,"artifact/boring-command.cjs"),name,input],{cwd:deployment,env,encoding:"utf8"});
            assert.equal(result.status,2,result.stderr);assert.match(result.stderr,new RegExp(code));
        }
        await processUntil("boring-command.cjs", async output=>output.includes("command waiting"),130,["health/check",'{"wait":true}']);
        env.BORING_CHECK_SLOW_SETUP = "true";
        try {
            await processUntil("boring-command.cjs", async output=>output.includes("setup waiting"),130,["health/check","{}"]);
            env.BORING_CHECK_FAIL_CLEANUP = "true";
            const error = await processUntil("boring-command.cjs", async output=>output.includes("setup waiting"),1,["health/check","{}"]);
            assert.equal(JSON.parse(error.replace("setup waiting\n", "")).error.code, "internal_error");
            delete env.BORING_CHECK_SLOW_SETUP;
            const activeError = await processUntil("boring-command.cjs", async output=>output.includes("command waiting"),1,["health/check",'{"wait":true}']);
            assert.equal(JSON.parse(activeError.replace("command waiting\n", "")).error.code, "internal_error");
        } finally { delete env.BORING_CHECK_SLOW_SETUP; delete env.BORING_CHECK_FAIL_CLEANUP; }
        console.log(`All ${packages.length} tarballs verified: public APIs and declarations, documentation, CLI build, relocated HTTP/custom-server and controlled execution with cleanup, compiled durable PostgreSQL worker, event consumer, scheduler, schedule worker and command with SIGTERM cleanup, and npm ci --omit=dev without development packages.`);
    } finally { await closeDatabase(); rmSync(temporary, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
