import { join } from "path";
import { BoringApi, ExecutionError, LifecycleError } from "@boringapi/core";
import type { Application } from "@boringapi/core";
import type { Server } from "node:http";

const port = Number(process.env.PORT ?? 4040);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("PORT must be an integer between 0 and 65535");
}

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

(async () => {
    let failure: unknown;
    let failed = false;
    try {
        application = await new BoringApi().createApp(join(__dirname, "api"));
        if (!stopping) {
            let server: Server | undefined;
            try {
                server = await application.listen(port, undefined, runtimeError);
            } catch (error) {
                if (!(stopping && error instanceof ExecutionError && error.code === "unavailable")) throw error;
            }
            if (server) {
                const address = server.address();
                console.info(`Listening on port ${typeof address === "object" && address ? address.port : port}`);
                await stopped;
            }
        }
    } catch (error) { failed = true; failure = error; }
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
        failure = lifecycleFailure(runtimeFailures.length && settlementFailed ? "HTTP runtime and cleanup failed" : "Startup and cleanup failed", errors);
        failed = errors.length > 0;
    }
    if (failed) { console.error(failure); process.exitCode = 1; }
})().catch(error => { console.error(error); process.exitCode = 1; });
