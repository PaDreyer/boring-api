import { BoringApi } from "@boringapi/core";
import { readConfiguration } from "@boringapi/compiler";
import { registerTypeScript } from "@boringapi/compiler/register";

async function serve(): Promise<void> {
    const [root, api, port, projectFile] = process.argv.slice(2);
    const configuration = readConfiguration(root, projectFile);
    registerTypeScript(api, configuration.options.configFilePath as string | undefined);
    await new BoringApi().listen(api, Number(port));
}

serve().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
