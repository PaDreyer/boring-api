import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { it } from "node:test";

it("owns a signal received while the custom production server is still starting", async () => {
    const script = `const {BoringApi}=require("@boringapi/core");const create=BoringApi.prototype.createApp;
BoringApi.prototype.createApp=async function(...args){const app=await create.apply(this,args);const close=app.close.bind(app);
app.close=async()=>{try{return await close();}finally{console.error("cleanup finished");}};
console.error("setup pending");await new Promise(resolve=>setTimeout(resolve,100));return app;};require("./server.ts");`;
    const child = spawn(process.execPath, ["-r", "ts-node/register", "-r", "./test/register.ts", "-e", script], {
        cwd: join(__dirname, ".."), stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PORT: "0" },
    });
    let output = "", sent = false;
    const receive = (chunk: Buffer) => {
        output += chunk.toString();
        if (!sent && output.includes("setup pending")) { sent = true; child.kill("SIGTERM"); }
    };
    child.stdout.on("data", receive); child.stderr.on("data", receive);
    const exited = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", () => resolve()); });
    const force = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { await exited; } finally { clearTimeout(force); }
    assert.ok(sent, output); assert.equal(child.signalCode, null, output); assert.equal(child.exitCode, 0, output);
    assert.equal((output.match(/cleanup finished/g) ?? []).length, 1, output);
    assert.doesNotMatch(output, /Listening on port/);
});

it("treats only a signal-interrupted custom listener start as a clean stop", async () => {
    const pendingScript = `const {BoringApi,ExecutionError}=require("@boringapi/core");
BoringApi.prototype.createApp=async()=>{let rejectListen,settle;const closed=new Promise(resolve=>{settle=resolve;});return {
listen:()=>new Promise((_,reject)=>{rejectListen=reject;console.error("listen pending");}),
close:async()=>{console.error("cleanup finished");rejectListen(new ExecutionError("unavailable","Application shut down while listening"));settle();},
get closed(){return closed;}};};require("./server.ts");`;
    const child = spawn(process.execPath, ["-r", "ts-node/register", "-r", "./test/register.ts", "-e", pendingScript], {
        cwd: join(__dirname, ".."), stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PORT: "0" },
    });
    let output = "", sent = false;
    const receive = (chunk: Buffer) => {
        output += chunk.toString();
        if (!sent && output.includes("listen pending")) { sent = true; child.kill("SIGTERM"); }
    };
    child.stdout.on("data", receive); child.stderr.on("data", receive);
    const exited = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", () => resolve()); });
    const force = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { await exited; } finally { clearTimeout(force); }
    assert.ok(sent, output); assert.equal(child.signalCode, null, output); assert.equal(child.exitCode, 0, output);
    assert.equal((output.match(/cleanup finished/g) ?? []).length, 1, output);
    assert.doesNotMatch(output, /Listening on port|Application shut down while listening/);

    const failedScript = `const {BoringApi}=require("@boringapi/core");
BoringApi.prototype.createApp=async()=>{let rejectListen,settle;const closed=new Promise(resolve=>{settle=resolve;});return {
listen:()=>new Promise((_,reject)=>{rejectListen=reject;console.error("real listener pending");}),
close:async()=>{console.error("cleanup finished");rejectListen(Object.assign(new Error("real listener failure"),{code:"EADDRINUSE"}));settle();},
get closed(){return closed;}};};require("./server.ts");`;
    const failed = spawn(process.execPath, ["-r", "ts-node/register", "-r", "./test/register.ts", "-e", failedScript], {
        cwd: join(__dirname, ".."), stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PORT: "0" },
    });
    let failedOutput = "", failedSent = false;
    const receiveFailed = (chunk: Buffer) => {
        failedOutput += chunk.toString();
        if (!failedSent && failedOutput.includes("real listener pending")) { failedSent = true; failed.kill("SIGTERM"); }
    };
    failed.stdout.on("data", receiveFailed); failed.stderr.on("data", receiveFailed);
    const failedExit = new Promise<void>((resolve, reject) => { failed.once("error", reject); failed.once("close", () => resolve()); });
    const failedForce = setTimeout(() => failed.kill("SIGKILL"), 5000);
    try { await failedExit; } finally { clearTimeout(failedForce); }
    assert.ok(failedSent, failedOutput); assert.equal(failed.signalCode, null, failedOutput); assert.equal(failed.exitCode, 1, failedOutput);
    assert.match(failedOutput, /real listener failure/);
    assert.equal((failedOutput.match(/cleanup finished/g) ?? []).length, 1, failedOutput);
});

it("owns a custom server runtime error through final cleanup", async () => {
    const script = `const {BoringApi}=require("@boringapi/core");const {EventEmitter}=require("node:events");
class TestServer extends EventEmitter {address(){return {port:4321};}off(name,listener){const result=super.off(name,listener);if(name==="error")console.error("runtime listener removed");return result;}}
BoringApi.prototype.createApp=async()=>{let server,observer,settle;const closed=new Promise(resolve=>{settle=resolve;});return {
listen:async(_port,_handler,onError)=>{observer=onError;server=new TestServer();server.on("error",observer);setImmediate(()=>server.emit("error",new Error("listener runtime failure")));return server;},
close:async()=>{console.error("cleanup finished");const repeated=new Error("repeated runtime failure");server.emit("error",repeated);server.emit("error",repeated);server.emit("error",new Error("second runtime failure"));server.off("error",observer);settle();},get closed(){return closed;}};};require("./server.ts");`;
    const child = spawn(process.execPath, ["-r", "ts-node/register", "-r", "./test/register.ts", "-e", script], {
        cwd: join(__dirname, ".."), stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PORT: "0" },
    });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk.toString(); });
    child.stderr.on("data", chunk => { output += chunk.toString(); });
    const exited = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", () => resolve()); });
    const force = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { await exited; } finally { clearTimeout(force); }
    assert.equal(child.signalCode, null, output); assert.equal(child.exitCode, 1, output);
    assert.match(output, /listener runtime failure/);
    assert.match(output, /repeated runtime failure/);
    assert.match(output, /second runtime failure/);
    assert.equal((output.match(/Error: repeated runtime failure/g) ?? []).length, 1, output);
    assert.equal((output.match(/cleanup finished/g) ?? []).length, 1, output);
    assert.equal((output.match(/runtime listener removed/g) ?? []).length, 1, output);
    assert.ok(output.indexOf("cleanup finished") < output.indexOf("runtime listener removed"), output);
});

it("captures a custom server runtime error that arrives during signal cleanup", async () => {
    for (const failCleanup of [false, true]) {
        const script = `const {BoringApi}=require("@boringapi/core");const {EventEmitter}=require("node:events");
BoringApi.prototype.createApp=async()=>{let server,settle,reject;const closed=new Promise((resolve,rejectPromise)=>{settle=resolve;reject=rejectPromise;});return {
listen:async(_port,_handler,onError)=>{server=new EventEmitter();server.on("error",onError);server.address=()=>({port:4321});console.error("listener ready for signal");return server;},
close:async()=>{console.error("cleanup finished");await new Promise(resolve=>setImmediate(()=>{server.emit("error",new Error("runtime error during cleanup"));resolve();}));
if(${JSON.stringify(failCleanup)}){const error=new Error("signal cleanup failure");reject(error);throw error;}settle();},get closed(){return closed;}};};require("./server.ts");`;
        const child = spawn(process.execPath, ["-r", "ts-node/register", "-r", "./test/register.ts", "-e", script], {
            cwd: join(__dirname, ".."), stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PORT: "0" },
        });
        let output = "", sent = false;
        const receive = (chunk: Buffer) => {
            output += chunk.toString();
            if (!sent && output.includes("listener ready for signal")) { sent = true; child.kill("SIGTERM"); }
        };
        child.stdout.on("data", receive); child.stderr.on("data", receive);
        const exited = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", () => resolve()); });
        const force = setTimeout(() => child.kill("SIGKILL"), 5000);
        try { await exited; } finally { clearTimeout(force); }
        assert.ok(sent, output); assert.equal(child.signalCode, null, output); assert.equal(child.exitCode, 1, output);
        assert.equal((output.match(/cleanup finished/g) ?? []).length, 1, output);
        assert.match(output, /runtime error during cleanup/);
        if (failCleanup) { assert.match(output, /HTTP runtime and cleanup failed/); assert.match(output, /signal cleanup failure/); }
    }
});
