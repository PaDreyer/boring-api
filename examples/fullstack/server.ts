import express from "express";
import { join, resolve } from "node:path";
import { BoringApi, ExecutionError, LifecycleError } from "@boringapi/core";
import type { Application } from "@boringapi/core";
import type { Server } from "node:http";

let application: Application | undefined;
let stopping = false;
let closing: Promise<void> | undefined;
let signalReceived!: () => void;
const stopped = new Promise<void>(resolve => { signalReceived = resolve; });
const processHold = setInterval(() => {}, 2147483647);
const runtimeFailures: unknown[] = [];

function addFailure(errors: unknown[], error: unknown): void {
    if (!errors.includes(error)) errors.push(error);
}
async function closeApplication(owner: Application): Promise<void> {
    const errors: unknown[] = [];
    try { await owner.close(); }
    catch (error) { addFailure(errors, error); }
    try { await owner.closed; }
    catch (error) { addFailure(errors, error); }
    if (errors.length) throw lifecycleFailure("Shutdown wait and eventual cleanup failed", errors);
}
function settleApplication(): Promise<void> {
    if (!application) return Promise.resolve();
    // Publish the shared Promise before close() can synchronously re-enter stop().
    if (!closing) {
        const owner = application;
        closing = Promise.resolve().then(() => closeApplication(owner));
    }
    return closing;
}
function lifecycleFailure(message: string, errors: readonly unknown[]): unknown {
    if (!errors.length) return undefined;
    if (errors.length === 1) return errors[0];
    const combined = new LifecycleError(message, errors);
    return combined.errors.length === 1 ? combined.errors[0] : combined;
}
const stop = () => {
    stopping = true;
    signalReceived();
    if (application) void settleApplication().catch(() => {});
};
const runtimeError = (error: Error) => {
    addFailure(runtimeFailures, error);
    stop();
};
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, stop);

async function main() {
    const app = express();
    app.disable("x-powered-by");
    application = await new BoringApi().createApp(join(__dirname, "api"));
    if (stopping) return;
    const owner = application;
    app.get("/health/live", (_request, response) => response.status(owner.health().status === "up" ? 200 : 503).json(owner.health()));
    app.get("/health/ready", async (_request, response) => {
        const report = await owner.readiness();
        response.status(report.status === "ready" ? 200 : 503).json(report);
    });
    app.get("/metrics", (_request, response) => response.json({ metrics: owner.metrics() }));
    const assets = process.env.WEB_DIST ? resolve(process.env.WEB_DIST) : join(__dirname, "web", "dist");
    app.use(express.static(assets));
    const port = Number(process.env.PORT ?? 4041);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT must be an integer between 0 and 65535");
    app.use(owner.http);
    let server: Server | undefined;
    try {
        server = await owner.listen(port, app, runtimeError);
    } catch (error) {
        if (!(stopping && error instanceof ExecutionError && error.code === "unavailable")) throw error;
    }
    if (server) {
        console.info(`Fullstack example listening on ${port}`);
        await stopped;
    }
}

(async () => {
    let failure: unknown;
    let failed = false;
    try { await main(); }
    catch (error) { failed = true; failure = error; }
    let settlementFailure: unknown;
    let settlementFailed = false;
    try { if (application) await settleApplication(); }
    catch (error) { settlementFailed = true; settlementFailure = error; }
    finally {
        const errors: unknown[] = [];
        if (failed) addFailure(errors, failure);
        if (settlementFailed) addFailure(errors, settlementFailure);
        // application.closed settles only after Core removes its owned listener.
        try {
            try { for (const signal of ["SIGINT", "SIGTERM"] as const) process.off(signal, stop); }
            finally { clearInterval(processHold); }
        } catch (error) { addFailure(errors, error); }
        for (const error of runtimeFailures) addFailure(errors, error);
        failure = lifecycleFailure(runtimeFailures.length && settlementFailed ? "Server runtime and cleanup failed" : "Server and cleanup failed", errors);
        failed = errors.length > 0;
    }
    if (failed) { console.error(failure); process.exitCode = 1; }
})().catch(error => { console.error(error); process.exitCode = 1; });
