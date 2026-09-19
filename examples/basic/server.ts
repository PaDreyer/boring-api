import { join } from "path";
import { BoringApi } from "../../src";
import { registerTypeScript } from "../../src/register";

if (__filename.endsWith(".ts")) registerTypeScript(join(__dirname, "api"));

const port = Number(process.env.PORT ?? 4040);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("PORT must be an integer between 0 and 65535");
}

new BoringApi().listen(join(__dirname, "api"), port).catch(error => {
    console.error(error);
    process.exitCode = 1;
});
