#!/usr/bin/env node
import { ChildProcess, spawn } from "child_process";
import { existsSync, readdirSync, watch, FSWatcher } from "fs";
import { basename, dirname, join, resolve } from "path";
import ts from "typescript";
import { BoringApi } from "./core";
import { generateTypes } from "./core/typegen";
import { formatArchitectureDiagnostics } from "./core/architecture";
import { analyzeProject, formatHost } from "./core/project";
import { formatInspection, inspectProject } from "./core/inspect";
import { buildProject } from "./core/build";
import { resolveStartDirectory } from "./core/start";
import { registerTypeScript } from "./register";
import { addEndpoint, addModule, initializeProject, ScaffoldResult } from "./core/scaffold";

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

function sync(root: string, apiDirectory: string): void {
    const result = generateTypes(root, apiDirectory);
    console.info(`Generated ${result.files.length} type file${result.files.length === 1 ? "" : "s"}.`);
}

function check(root: string, args: Arguments): number {
    const project = analyzeProject(root, args.apiDirectory, args.projectFile);
    const { diagnostics, architecture } = project;
    if (diagnostics.length) {
        console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, formatHost(root)));
    }
    if (architecture.length) console.error(formatArchitectureDiagnostics(architecture, root));
    if (diagnostics.length || architecture.length) return 1;
    if (args.command === "build") {
        const built = buildProject(project);
        if (built.diagnostics.length) {
            console.error(ts.formatDiagnosticsWithColorAndContext(built.diagnostics, formatHost(root)));
            return 1;
        }
        console.info(`Built application in ${built.output}.`);
    } else if (args.command === "inspect") {
        const result = inspectProject(project);
        console.info(args.json ? JSON.stringify(result, null, 2) : formatInspection(result));
    } else console.info(`Checked ${project.sources.contracts.length} API source files.`);
    return 0;
}

async function serve(root: string, apiDirectory: string, port: number): Promise<void> {
    await new BoringApi().listen(resolve(root, apiDirectory), port);
}

function watchDirectories(directory: string, onChange: () => void): () => void {
    const parent = dirname(directory);
    const names = new Set([basename(directory), "modules", "infra"]);
    let watchers: FSWatcher[] = [];
    let timer: NodeJS.Timeout | undefined;
    let stopped = false;
    const scheduleRefresh = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(refresh, 50);
    };
    const refresh = () => {
        if (stopped) return;
        for (const watcher of watchers) watcher.close();
        watchers = [];
        const visit = (current: string) => {
            try {
                const entries = readdirSync(current, { withFileTypes: true });
                watchers.push(watch(current, (event) => {
                    if (stopped) return;
                    onChange();
                    if (event === "rename") scheduleRefresh();
                }));
                for (const entry of entries) {
                    if (entry.isDirectory()) visit(join(current, entry.name));
                }
            } catch (error) {
                // A source directory may be absent, removed or replaced during a save.
                const code = (error as NodeJS.ErrnoException).code;
                if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
            }
        };
        // Notice sibling roots created after dev starts, without watching build output.
        watchers.push(watch(parent, (_event, filename) => {
            if (stopped || (filename !== null && !names.has(filename.toString()))) return;
            onChange();
            scheduleRefresh();
        }));
        for (const name of names) visit(join(parent, name));
    };
    refresh();
    return () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        for (const watcher of watchers) watcher.close();
    };
}

async function dev(root: string, apiDirectory: string, port: number, projectFile?: string): Promise<void> {
    const api = resolve(root, apiDirectory);
    sync(root, apiDirectory);
    let child: ChildProcess | undefined;
    let timer: NodeJS.Timeout | undefined;
    let restartRequested = false;
    let stopping = false;

    const start = () => {
        if (stopping) return;
        const register = require.resolve("ts-node/register/transpile-only");
        const spawned = spawn(process.execPath, ["-r", register, process.argv[1], "__serve", api, "--port", String(port),
            ...(projectFile ? ["--project", resolve(root, projectFile)] : [])], {
            cwd: root,
            stdio: "inherit",
        });
        child = spawned;
        spawned.once("exit", () => {
            if (child === spawned) child = undefined;
            if (restartRequested && !stopping) {
                restartRequested = false;
                start();
            }
        });
    };
    const restart = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            try {
                sync(root, apiDirectory);
                if (child && child.exitCode === null) {
                    restartRequested = true;
                    if (!child.killed) child.kill("SIGTERM");
                } else {
                    restartRequested = false;
                    start();
                }
            } catch (error) {
                console.error(error);
            }
        }, 100);
    };
    const closeWatchers = watchDirectories(api, restart);
    const stop = () => {
        stopping = true;
        restartRequested = false;
        if (timer) clearTimeout(timer);
        closeWatchers();
        child?.kill("SIGTERM");
    };
    process.once("SIGINT", () => { stop(); process.exit(130); });
    process.once("SIGTERM", () => { stop(); process.exit(143); });
    start();
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
        case "sync": sync(root, args.apiDirectory); break;
        case "check":
        case "inspect":
        case "build": process.exitCode = check(root, args); break;
        case "start":
            await serve(root, resolveStartDirectory(root, {
                apiDirectory: args.explicitDirectory ? args.apiDirectory : undefined,
                outputDirectory: args.outputDirectory, projectFile: args.projectFile,
            }), args.port);
            break;
        case "dev": await dev(root, args.apiDirectory, args.port, args.projectFile); break;
        case "__serve":
            registerTypeScript(resolve(root, args.apiDirectory), args.projectFile ? resolve(root, args.projectFile)
                : ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json"));
            await serve(root, args.apiDirectory, args.port);
            break;
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
