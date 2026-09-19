#!/usr/bin/env node
import { ChildProcess, spawn } from "child_process";
import { existsSync, readdirSync, watch, FSWatcher } from "fs";
import { dirname, join, resolve } from "path";
import ts from "typescript";
import { BoringApi } from "./core";
import { generateTypes } from "./core/typegen";

interface Arguments {
    command: string;
    apiDirectory: string;
    port: number;
}

function parseArguments(argv: string[]): Arguments {
    const command = argv[0] ?? "help";
    let apiDirectory = "api";
    let port = Number(process.env.PORT ?? 4040);
    for (let index = 1; index < argv.length; index++) {
        const value = argv[index];
        if (value === "--port") {
            port = Number(argv[++index]);
        } else if (value === "--dir") {
            apiDirectory = argv[++index];
        } else if (!value.startsWith("-")) {
            apiDirectory = value;
        } else {
            throw new Error(`Unknown option: ${value}`);
        }
    }
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error("--port must be an integer between 0 and 65535");
    }
    return { command, apiDirectory, port };
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

function check(root: string, apiDirectory: string): number {
    const generated = generateTypes(root, apiDirectory);
    const configFile = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json");
    const configDiagnostics: ts.Diagnostic[] = [];
    let fileNames: string[] = [];
    let options: ts.CompilerOptions = {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
        moduleResolution: ts.ModuleResolutionKind.NodeJs,
        esModuleInterop: true,
        strict: true,
        skipLibCheck: true,
    };

    if (configFile) {
        const loaded = ts.readConfigFile(configFile, ts.sys.readFile);
        if (loaded.error) {
            console.error(ts.formatDiagnosticsWithColorAndContext([loaded.error], formatHost(root)));
            return 1;
        }
        const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, dirname(configFile), undefined, configFile);
        configDiagnostics.push(...parsed.errors);
        fileNames = parsed.fileNames;
        options = parsed.options;
    }

    const sourceFiles = collectSourceFiles(generated.apiDirectory);
    fileNames = [...new Set([...fileNames, ...sourceFiles, ...generated.files])];
    options = {
        ...options,
        noEmit: true,
        allowJs: true,
        rootDir: undefined,
        rootDirs: [...(options.rootDirs ?? []), root, generated.generatedRoot],
    };

    const program = ts.createProgram({ rootNames: fileNames, options });
    const diagnostics = [...configDiagnostics, ...ts.getPreEmitDiagnostics(program)];
    if (diagnostics.length) {
        console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, formatHost(root)));
        return 1;
    }
    console.info(`Checked ${sourceFiles.length} API source file${sourceFiles.length === 1 ? "" : "s"}.`);
    return 0;
}

function formatHost(root: string): ts.FormatDiagnosticsHost {
    return {
        getCanonicalFileName: file => file,
        getCurrentDirectory: () => root,
        getNewLine: () => ts.sys.newLine,
    };
}

function collectSourceFiles(directory: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const file = join(directory, entry.name);
        if (entry.isDirectory()) files.push(...collectSourceFiles(file));
        else if ((file.endsWith(".ts") || file.endsWith(".js")) && !file.endsWith(".d.ts")) files.push(file);
    }
    return files;
}

async function serve(root: string, apiDirectory: string, port: number): Promise<void> {
    await new BoringApi().listen(resolve(root, apiDirectory), port);
}

function watchDirectories(directory: string, onChange: () => void): () => void {
    let watchers: FSWatcher[] = [];
    let refreshing = false;
    const refresh = () => {
        if (refreshing) return;
        refreshing = true;
        for (const watcher of watchers) watcher.close();
        watchers = [];
        const visit = (current: string) => {
            watchers.push(watch(current, (event) => {
                onChange();
                if (event === "rename") setTimeout(refresh, 150);
            }));
            for (const entry of readdirSync(current, { withFileTypes: true })) {
                if (entry.isDirectory()) visit(join(current, entry.name));
            }
        };
        visit(directory);
        refreshing = false;
    };
    refresh();
    return () => watchers.forEach(watcher => watcher.close());
}

async function dev(root: string, apiDirectory: string, port: number): Promise<void> {
    const api = resolve(root, apiDirectory);
    sync(root, apiDirectory);
    let child: ChildProcess | undefined;
    let timer: NodeJS.Timeout | undefined;
    let restartRequested = false;
    let stopping = false;

    const start = () => {
        if (stopping) return;
        const register = require.resolve("ts-node/register/transpile-only");
        const spawned = spawn(process.execPath, ["-r", register, process.argv[1], "__serve", api, "--port", String(port)], {
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
  boring dev [api-directory] [--port 4040]
  boring check [api-directory]
  boring start [api-directory] [--port 4040]
  boring sync [api-directory]

The API directory defaults to ./api.`);
}

async function main(): Promise<void> {
    const args = parseArguments(process.argv.slice(2));
    const root = projectRoot(process.cwd());
    switch (args.command) {
        case "sync": sync(root, args.apiDirectory); break;
        case "check": process.exitCode = check(root, args.apiDirectory); break;
        case "start": await serve(root, args.apiDirectory, args.port); break;
        case "dev": await dev(root, args.apiDirectory, args.port); break;
        case "__serve": await serve(root, args.apiDirectory, args.port); break;
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
