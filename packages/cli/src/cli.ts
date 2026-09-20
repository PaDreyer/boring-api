#!/usr/bin/env node
import { existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { formatDiagnostics } from "@boringapi/compiler";
import { analyzeProject, synchronizeProject, formatArchitectureDiagnostics, formatInspection, inspectProject } from "@boringapi/analyzer";
import { buildProject, startProject } from "@boringapi/build";
import { startDevServer } from "@boringapi/dev";
import { addEndpoint, addModule, initializeProject, ScaffoldResult } from "@boringapi/scaffold";

interface Arguments {
    command: string;
    apiDirectory: string;
    explicitDirectory: boolean;
    outputDirectory?: string;
    port: number;
    json: boolean;
    projectFile?: string;
}

function parseArguments(argv: string[]): Arguments {
    const command = argv[0] ?? "help";
    let apiDirectory = "api";
    let explicitDirectory = false;
    let outputDirectory: string | undefined;
    let port = Number(process.env.PORT ?? 4040);
    let json = false;
    let projectFile: string | undefined;
    for (let index = 1; index < argv.length; index++) {
        const value = argv[index];
        const argument = () => {
            const next = argv[++index];
            if (!next || next.startsWith("--")) throw new Error(`${value} requires a value`);
            return next;
        };
        if (value === "--port") {
            port = Number(argument());
        } else if (value === "--dir") {
            if (explicitDirectory) throw new Error("Specify only one API directory.");
            apiDirectory = argument();
            explicitDirectory = true;
        } else if (value === "--out-dir" && command === "start") {
            outputDirectory = argument();
        } else if (value === "--json" && command === "inspect") {
            json = true;
        } else if (value === "--project") {
            projectFile = argument();
        } else if (!value.startsWith("-")) {
            if (explicitDirectory) throw new Error("Specify only one API directory.");
            apiDirectory = value;
            explicitDirectory = true;
        } else {
            throw new Error(`Unknown option: ${value}`);
        }
    }
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error("--port must be an integer between 0 and 65535");
    }
    return { command, apiDirectory, explicitDirectory, outputDirectory, port, json, projectFile };
}

function projectRoot(from: string): string {
    let current = resolve(from);
    while (true) {
        if (existsSync(join(current, "package.json"))) return current;
        const parent = dirname(current);
        if (parent === current) return resolve(from);
        current = parent;
    }
}

function sync(root: string, apiDirectory: string, projectFile?: string): void {
    const result = synchronizeProject(root, apiDirectory, projectFile);
    console.info(`Generated ${result.files.length} type file${result.files.length === 1 ? "" : "s"}.`);
}

function check(root: string, args: Arguments): number {
    const project = analyzeProject(root, args.apiDirectory, args.projectFile);
    const { diagnostics, architecture } = project;
    if (diagnostics.length) {
        console.error(formatDiagnostics(diagnostics, root));
    }
    if (architecture.length) console.error(formatArchitectureDiagnostics(architecture, root));
    if (diagnostics.length || architecture.length) return 1;
    if (args.command === "build") {
        const built = buildProject(project);
        if (built.diagnostics.length) {
            console.error(formatDiagnostics(built.diagnostics, root));
            return 1;
        }
        console.info(`Built application in ${built.output}.`);
    } else if (args.command === "inspect") {
        const result = inspectProject(project);
        console.info(args.json ? JSON.stringify(result, null, 2) : formatInspection(result));
    } else console.info(`Checked ${project.sources.contracts.length} API source files.`);
    return 0;
}

function usage(): void {
    console.info(`Boring API

Usage:
  boring init [project-directory] [--dir api]
  boring add module <name> [--dir api]
  boring add endpoint <path/method> [--dir api] [--from path/method]
  boring dev [api-directory] [--port 4040]
  boring check [api-directory]
  boring inspect [api-directory] [--json]
  boring build [api-directory]
  boring start [compiled-api-directory] [--out-dir directory | --project tsconfig] [--port 4040]
  boring sync [api-directory]

Source commands default to ./api. Use --project <tsconfig> for a custom configuration.
Start uses the last successful build, or ./dist in a deployment. Use --out-dir
for another build directory, or pass a compiled API directory directly.`);
}

function scaffold(argv: string[]): void {
    const positional: string[] = [];
    let api = "api";
    let from: string | undefined;
    let project: string | undefined;
    for (let index = 1; index < argv.length; index++) {
        const value = argv[index];
        if (["--dir", "--from", "--project"].includes(value)) {
            const argument = argv[++index];
            if (!argument || argument.startsWith("--")) throw new Error(`${value} requires a value.`);
            if (value === "--dir") api = argument;
            else if (value === "--from") from = argument;
            else project = argument;
        } else if (value.startsWith("-")) throw new Error(`Unknown option: ${value}`);
        else positional.push(value);
    }
    let result: ScaffoldResult;
    if (argv[0] === "init") {
        if (positional.length > 1 || from !== undefined || project !== undefined) throw new Error("Usage: boring init [project-directory] [--dir api]");
        result = initializeProject(resolve(process.cwd(), positional[0] ?? "."), api);
    } else {
        const [kind, name] = positional;
        if (positional.length !== 2 || !["module", "endpoint"].includes(kind) || (from !== undefined && kind !== "endpoint")) {
            throw new Error("Usage: boring add module <name> or boring add endpoint <path/method> [--from path/method], with optional --dir and --project.");
        }
        const root = projectRoot(process.cwd());
        result = kind === "module" ? addModule(root, api, name, project) : addEndpoint(root, api, name, from, project);
    }
    for (const file of result.files) console.info(`Wrote ${file}`);
    for (const note of result.notes) console.info(note);
}

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    if (argv[0] === "init" || argv[0] === "add") { scaffold(argv); return; }
    const args = parseArguments(argv);
    const root = projectRoot(process.cwd());
    switch (args.command) {
        case "sync": sync(root, args.apiDirectory, args.projectFile); break;
        case "check":
        case "inspect":
        case "build": process.exitCode = check(root, args); break;
        case "start": {
            const application = await startProject(root, {
                apiDirectory: args.explicitDirectory ? args.apiDirectory : undefined,
                outputDirectory: args.outputDirectory, projectFile: args.projectFile,
            }, args.port);
            for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
                void application.close().catch(error => { console.error(error); process.exitCode = 1; });
            });
            break;
        }
        case "dev": {
            const server = startDevServer(root, args.apiDirectory, args.port, args.projectFile);
            process.once("SIGINT", () => { void server.close().then(() => process.exit(130)); });
            process.once("SIGTERM", () => { void server.close().then(() => process.exit(143)); });
            break;
        }
        case "help":
        case "--help":
        case "-h": usage(); break;
        default: throw new Error(`Unknown command '${args.command}'. Run boring --help.`);
    }
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
