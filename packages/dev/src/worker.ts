import { BoringApi } from "@boringapi/core";
import { readConfiguration } from "@boringapi/compiler";
import { registerTypeScript } from "@boringapi/compiler/register";

async function serve(): Promise<void> {
    const [root, api, port, projectFile] = process.argv.slice(2);
    const configuration = readConfiguration(root, projectFile);
    registerTypeScript(api, configuration.options.configFilePath as string | undefined);
    const application = await new BoringApi().listen(api, Number(port), { shutdownGraceMs: 1000, shutdownTimeoutMs: 4000 });
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
        void application.close().catch(error => { console.error(error); process.exitCode = 1; });
    });
}

serve().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
