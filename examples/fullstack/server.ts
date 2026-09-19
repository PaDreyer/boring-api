import express from "express";
import { join, resolve } from "node:path";
import { BoringApi } from "@boringapi/core";
import { registerTypeScript } from "@boringapi/core/register";

if (__filename.endsWith(".ts")) registerTypeScript(join(__dirname, "api"), join(__dirname, "tsconfig.json"));

async function main() {
    const app = express();
    app.disable("x-powered-by");
    const assets = process.env.WEB_DIST ? resolve(process.env.WEB_DIST) : join(__dirname, "web", "dist");
    app.use(express.static(assets));
    app.use(await new BoringApi().createApp(join(__dirname, "api")));
    const port = Number(process.env.PORT ?? 4041);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT must be an integer between 0 and 65535");
    const server = app.listen(port, () => console.info(`Fullstack example listening on ${port}`));
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => server.close());
    server.once("error", error => { console.error(error); process.exitCode = 1; });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
