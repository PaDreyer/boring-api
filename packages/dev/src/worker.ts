import { BoringApi } from "@boringapi/core";
import type { Application } from "@boringapi/core";
import { readConfiguration } from "@boringapi/compiler";
import { registerTypeScript } from "@boringapi/compiler/register";

async function serve(): Promise<void> {
    const [root, api, port, projectFile, mode] = process.argv.slice(2);
    let application: Application | undefined;
    let unregister: (() => void) | undefined;
    let stopping = false;
    let signalReceived!: () => void;
    const stopped = new Promise<void>(resolve => { signalReceived = resolve; });
    const stop = () => {
        stopping = true;
        signalReceived();
        if (application) void application.close().catch(() => {});
    };
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, stop);
    try {
        const configuration = readConfiguration(root, projectFile || undefined);
        unregister = registerTypeScript(api, configuration.options.configFilePath as string | undefined);
        application = await new BoringApi().createApp(api, { shutdownGraceMs: 1000, shutdownTimeoutMs: 4000 });
        if (!stopping) {
            if (["jobs", "scheduler", "schedule", "event"].includes(mode)) {
                if (mode === "scheduler") await application.schedule();
                else await application.work({ kind: mode === "event" ? "event" : mode === "schedule" ? "schedule" : "job" });
            } else {
                const server = await application.listen(Number(port));
                const address = server.address();
                console.info(`Listening on port ${typeof address === "object" && address ? address.port : port}`);
                await stopped;
            }
        }
    } finally {
        try { if (application) { try { await application.close(); } finally { await application.closed; } } }
        finally {
            unregister?.();
            for (const signal of ["SIGINT", "SIGTERM"] as const) process.off(signal, stop);
        }
    }
}

serve().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
