import type { Server } from "http";
import { BoringApi, ExecutionError, LifecycleError } from "@boringapi/core";
import type { Application } from "@boringapi/core";
import { readConfiguration } from "@boringapi/compiler";
import { registerTypeScript } from "@boringapi/compiler/register";

function lifecycleFailure(message: string, errors: readonly unknown[]): unknown {
    if (!errors.length) return undefined;
    if (errors.length === 1) return errors[0];
    const combined = new LifecycleError(message, errors);
    return combined.errors.length === 1 ? combined.errors[0] : combined;
}

function addFailure(errors: unknown[], error: unknown): void {
    if (!errors.includes(error)) errors.push(error);
}

async function closeApplication(application: Application): Promise<void> {
    const errors: unknown[] = [];
    try { await application.close(); }
    catch (error) { addFailure(errors, error); }
    try { await application.closed; }
    catch (error) { addFailure(errors, error); }
    if (errors.length) throw lifecycleFailure("Shutdown wait and eventual cleanup failed", errors);
}

async function serve(): Promise<void> {
    // Setup and eventual cleanup may both be handleless pending Promises.
    const processHold = setInterval(() => {}, 2147483647);
    const [root, api, port, projectFile, mode] = process.argv.slice(2);
    let application: Application | undefined;
    let closing: Promise<void> | undefined;
    let runtimeServer: Server | undefined;
    let unregister: (() => void) | undefined;
    let stopping = false;
    let signalReceived!: () => void;
    const stopped = new Promise<void>(resolve => { signalReceived = resolve; });
    const settleApplication = () => {
        if (!application) return Promise.resolve();
        // Publish the shared Promise before close() can synchronously re-enter
        // through a runtime listener error.
        if (!closing) {
            const owner = application;
            closing = Promise.resolve().then(() => closeApplication(owner));
        }
        return closing;
    };
    const stop = () => {
        stopping = true;
        signalReceived();
        if (application) void settleApplication().catch(() => {});
    };
    const runtimeFailures: unknown[] = [];
    const runtimeError = (error: Error) => {
        addFailure(runtimeFailures, error);
        stop();
    };
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, stop);
    let failed = false, failure: unknown;
    try {
        const configuration = readConfiguration(root, projectFile || undefined);
        unregister = registerTypeScript(api, configuration.options.configFilePath as string | undefined);
        application = await new BoringApi().createApp(api, { shutdownGraceMs: 1000, shutdownTimeoutMs: 4000 });
        if (!stopping) {
            if (["jobs", "scheduler", "schedule", "event", "publication"].includes(mode)) {
                if (mode === "scheduler") await application.schedule();
                else await application.work({ kind: mode === "event" ? "event" : mode === "schedule" ? "schedule" : mode === "publication" ? "publication" : "job" });
            } else {
                try { runtimeServer = await application.listen(Number(port), undefined, runtimeError); }
                catch (error) {
                    if (!(stopping && error instanceof ExecutionError && error.code === "unavailable")) throw error;
                }
                if (runtimeServer) {
                    const address = runtimeServer.address();
                    console.info(`Listening on port ${typeof address === "object" && address ? address.port : port}`);
                    await stopped;
                }
            }
        }
    } catch (error) { failed = true; failure = error; }
    let settlementFailed = false, settlementFailure: unknown;
    try { if (application) await settleApplication(); }
    catch (error) { settlementFailed = true; settlementFailure = error; }
    const cleanupErrors: unknown[] = [];
    // application.closed settles only after Core removes its owned listener.
    try { unregister?.(); }
    catch (error) { addFailure(cleanupErrors, error); }
    try { for (const signal of ["SIGINT", "SIGTERM"] as const) process.off(signal, stop); }
    catch (error) { addFailure(cleanupErrors, error); }
    finally { clearInterval(processHold); }
    const errors: unknown[] = [];
    if (failed) addFailure(errors, failure);
    if (settlementFailed) addFailure(errors, settlementFailure);
    for (const error of runtimeFailures) addFailure(errors, error);
    for (const error of cleanupErrors) addFailure(errors, error);
    if (errors.length) throw lifecycleFailure(runtimeFailures.length && settlementFailed ? "HTTP runtime and cleanup failed" : "Development runtime and cleanup failed", errors);
}

serve().catch(error => {
    console.error(error instanceof LifecycleError ? error : error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
