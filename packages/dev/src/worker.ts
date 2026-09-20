import { BoringApi } from "@boringapi/core";
import { readConfiguration } from "@boringapi/compiler";
import { registerTypeScript } from "@boringapi/compiler/register";

async function serve(): Promise<void> {
    const [root, api, port, projectFile, mode] = process.argv.slice(2);
    const configuration = readConfiguration(root, projectFile || undefined);
    registerTypeScript(api, configuration.options.configFilePath as string | undefined);
    const application = await new BoringApi().createApp(api, { shutdownGraceMs: 1000, shutdownTimeoutMs: 4000 });
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
        void application.close().catch(error => { console.error(error); process.exitCode = 1; });
    });
    if (mode === "jobs") {
        try { await application.work(); } finally { await application.close(); }
    } else {
        const server = await application.listen(Number(port));
        const address = server.address();
        console.info(`Listening on port ${typeof address === "object" && address ? address.port : port}`);
    }
}

serve().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
