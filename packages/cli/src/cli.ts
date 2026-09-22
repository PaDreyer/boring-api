#!/usr/bin/env node
import { existsSync } from "fs";
import type { Server } from "http";
import { dirname, join, resolve } from "path";
import { formatDiagnostics } from "@boringapi/compiler";
import { analyzeProject, synchronizeProject, formatArchitectureDiagnostics, formatInspection, inspectProject } from "@boringapi/analyzer";
import { buildProject, startWorker } from "@boringapi/build";
import { commandFailure, ExecutionError, LifecycleError } from "@boringapi/core";
import type { Application } from "@boringapi/core";
import { runSourceCommand, startDevServer } from "@boringapi/dev";
import { addEndpoint, addJob, addTrigger, addModule, initializeProject, ScaffoldResult } from "@boringapi/scaffold";

interface Arguments {
    command: string;
    apiDirectory: string;
    explicitDirectory: boolean;
    outputDirectory?: string;
    port: number;
    json: boolean;
    worker: boolean | "scheduler" | "schedule" | "event" | "publication";
    projectFile?: string;
}

function parseArguments(argv: string[]): Arguments {
    const command = argv[0] ?? "help";
    let apiDirectory = "api";
    let explicitDirectory = false;
    let outputDirectory: string | undefined;
    let port = Number(process.env.PORT ?? 4040);
    let json = false;
    let worker: Arguments["worker"] = false;
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
        } else if (value === "--worker" && command === "dev") {
            if (worker) throw new Error("Choose only one development process kind");
            worker = true;
        } else if (["--scheduler", "--schedule-worker", "--consumer", "--publisher"].includes(value) && command === "dev") {
            if (worker) throw new Error("Choose only one development process kind");
            worker = value === "--scheduler" ? "scheduler" : value === "--consumer" ? "event" : value === "--publisher" ? "publication" : "schedule";
        } else if (value === "--out-dir" && ["start", "worker", "scheduler", "schedule-worker", "consumer", "publisher"].includes(command)) {
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
    return { command, apiDirectory, explicitDirectory, outputDirectory, port, json, worker, projectFile };
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

function retainProcess(): NodeJS.Timeout {
    // Promises do not retain Node. Runtime commands own the process until setup,
    // execution and eventual cleanup have all settled.
    return setInterval(() => {}, 2147483647);
}

function sync(root: string, apiDirectory: string, projectFile?: string): void {
    const result = synchronizeProject(root, apiDirectory, projectFile);
    console.info(`Generated ${result.files.length} type file${result.files.length === 1 ? "" : "s"}.`);
}

function check(root: string, args: Arguments): number {
    const project = analyzeProject(root, args.apiDirectory, args.projectFile);
    const { diagnostics, architecture } = project;
    if (diagnostics.length) {
        console.error(formatDiagnostics(diagnostics, project.projectRoot));
    }
    if (architecture.length) console.error(formatArchitectureDiagnostics(architecture, project.projectRoot));
    if (diagnostics.length || architecture.length) return 1;
    if (args.command === "build") {
        const built = buildProject(project);
        if (built.diagnostics.length) {
            console.error(formatDiagnostics(built.diagnostics, project.projectRoot));
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
  boring add job <name> --from <service.operation> --payload <module.schema> [--dir api]
  boring add schedule|event|command <name> --from <operation> --payload <schema> [trigger options]
  boring add endpoint <path/method> [--dir api] [--from path/method]
  boring dev [api-directory] [--port 4040] [--worker | --scheduler | --schedule-worker | --consumer | --publisher]
  boring command <name> --input '<JSON>' [--source --dir api | --out-dir dist]
  boring scheduler | schedule-worker | consumer | publisher [--out-dir dist]
  boring worker [compiled-api-directory] [--out-dir directory | --project tsconfig]
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
    let payload: string | undefined;
    let project: string | undefined;
    const trigger: Record<string, string> = {};
    for (let index = 1; index < argv.length; index++) {
        const value = argv[index];
        if (["--dir", "--from", "--project", "--payload", "--output", "--input", "--timing", "--event", "--event-version"].includes(value)) {
            const argument = argv[++index];
            if (!argument || argument.startsWith("--")) throw new Error(`${value} requires a value.`);
            if (value === "--dir") api = argument;
            else if (value === "--from") from = argument;
            else if (value === "--payload") payload = argument;
            else if (value === "--project") project = argument;
            else trigger[value.slice(2)] = argument;
        } else if (value.startsWith("-")) throw new Error(`Unknown option: ${value}`);
        else positional.push(value);
    }
    let result: ScaffoldResult;
    if (argv[0] === "init") {
        if (positional.length > 1 || from !== undefined || project !== undefined || payload !== undefined) throw new Error("Usage: boring init [project-directory] [--dir api]");
        result = initializeProject(resolve(process.cwd(), positional[0] ?? "."), api);
    } else {
        const [kind, name] = positional;
        if (positional.length !== 2 || !["module", "endpoint", "job", "schedule", "event", "command"].includes(kind) || (from !== undefined && kind === "module") || (payload !== undefined && ["module", "endpoint"].includes(kind))) {
            throw new Error("Usage: boring add module <name> or boring add endpoint <path/method> [--from path/method], with optional --dir and --project.");
        }
        const root = projectRoot(process.cwd());
        if (kind === "job" && (!from || !payload)) throw new Error("Usage: boring add job <name> --from <service.operation> --payload <module.schema>");
        if (["schedule", "event", "command"].includes(kind)) {
            if (!from || !payload) throw new Error("Trigger generation requires --from and --payload");
            result = addTrigger(root, api, kind as "schedule" | "event" | "command", name, { from, payload, output: trigger.output,
                input: trigger.input === undefined ? undefined : JSON.parse(trigger.input), timing: trigger.timing === undefined ? undefined : JSON.parse(trigger.timing),
                event: trigger.event === undefined ? undefined : { type: trigger.event, version: Number(trigger["event-version"]) } }, project);
        } else result = kind === "job" ? addJob(root, api, name, from!, payload!, project) : kind === "module" ? addModule(root, api, name, project) : addEndpoint(root, api, name, from, project);
    }
    for (const file of result.files) console.info(`Wrote ${file}`);
    for (const note of result.notes) console.info(note);
}

async function command(argv: string[]): Promise<void> {
    const processHold = retainProcess();
    const cancel = new AbortController();
    const stop = () => cancel.abort();
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, stop);
    try {
        const name = argv.shift();
        let source = false;
        let input: string | undefined;
        // Commands have no HTTP listener and do not read PORT.
        const target: string[] = ["worker", "--port", "0"];
        for (let i = 0; i < argv.length; i++) {
            if (argv[i] === "--source") source = true;
            else if (argv[i] === "--input") { if (input !== undefined || argv[i + 1] === undefined) throw new SyntaxError("Supply one --input JSON value"); input = argv[++i]; }
            else if (["--dir", "--out-dir", "--project"].includes(argv[i])) {
                if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new SyntaxError(`${argv[i]} requires a value`);
                target.push(argv[i], argv[++i]);
            } else throw new SyntaxError(`Unknown command option: ${argv[i]}`);
        }
        if (!name || name.startsWith("-") || input === undefined) throw new SyntaxError("Usage: boring command <name> --input '<JSON>' [--source --dir api | --out-dir dist]");
        const payload = JSON.parse(input);
        const args = parseArguments(target);
        const root = projectRoot(process.cwd());
        if (source && args.outputDirectory) throw new SyntaxError("--source cannot select compiled output");
        let result: unknown;
        if (source) result = await runSourceCommand(root, args.apiDirectory, name, payload, args.projectFile, cancel.signal);
        else {
            const application = await startWorker(root, { apiDirectory: args.explicitDirectory ? args.apiDirectory : undefined, outputDirectory: args.outputDirectory, projectFile: args.projectFile });
            let failed = false, failure: unknown;
            try { result = await application.command(name, payload, { signal: cancel.signal }); }
            catch (error) { failed = true; failure = error; }
            try { await closeApplication(application); }
            catch (error) {
                failure = failed ? lifecycleFailure("Command execution and cleanup failed", [failure, error]) : error;
                failed = true;
            }
            if (failed) throw failure;
        }
        if (cancel.signal.aborted) throw new ExecutionError("cancelled", "Command cancelled");
        console.log(JSON.stringify(result));
    } catch (error) {
        const failure = commandFailure(error);
        console.error(JSON.stringify({ error: failure.error }));
        process.exitCode = failure.exitCode;
    } finally {
        try { for (const signal of ["SIGINT", "SIGTERM"] as const) process.off(signal, stop); }
        finally { clearInterval(processHold); }
    }
}

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    if (argv[0] === "command") { await command(argv.slice(1)); return; }
    if (argv[0] === "init" || argv[0] === "add") { scaffold(argv); return; }
    const args = parseArguments(argv);
    const root = projectRoot(process.cwd());
    switch (args.command) {
        case "sync": sync(root, args.apiDirectory, args.projectFile); break;
        case "check":
        case "inspect":
        case "build": process.exitCode = check(root, args); break;
        case "scheduler":
        case "schedule-worker":
        case "consumer":
        case "publisher":
        case "worker":
        case "start": {
            const processHold = retainProcess();
            let application: Application | undefined;
            let closing: Promise<void> | undefined;
            let runtimeServer: Server | undefined;
            let stopping = false;
            let signalReceived!: () => void;
            const stopped = new Promise<void>(resolve => { signalReceived = resolve; });
            const runtimeFailures: unknown[] = [];
            const settleApplication = () => {
                if (!application) return Promise.resolve();
                // Publish the shared Promise before close() can synchronously
                // re-enter through a runtime listener error.
                if (!closing) {
                    const owner = application;
                    closing = Promise.resolve().then(() => closeApplication(owner));
                }
                return closing;
            };
            const stop = () => {
                stopping = true;
                signalReceived();
                // The awaited lifecycle below reports cleanup errors exactly once.
                if (application) void settleApplication().catch(() => {});
            };
            const runtimeError = (error: Error) => {
                addFailure(runtimeFailures, error);
                stop();
            };
            for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, stop);
            let failed = false, failure: unknown;
            try {
                application = await startWorker(root, {
                    apiDirectory: args.explicitDirectory ? args.apiDirectory : undefined,
                    outputDirectory: args.outputDirectory, projectFile: args.projectFile,
                });
                if (!stopping) {
                    if (args.command === "start") {
                        try { runtimeServer = await application.listen(args.port, undefined, runtimeError); }
                        catch (error) {
                            // Shutdown can close a listener whose admission is still pending.
                            if (!(stopping && error instanceof ExecutionError && error.code === "unavailable")) throw error;
                        }
                        if (runtimeServer) {
                            const address = runtimeServer.address();
                            console.info(`Listening on port ${typeof address === "object" && address ? address.port : args.port}`);
                            await stopped;
                        }
                    }
                    else if (args.command === "scheduler") await application.schedule();
                    else await application.work({ kind: args.command === "consumer" ? "event" : args.command === "schedule-worker" ? "schedule" : args.command === "publisher" ? "publication" : "job" });
                }
            } catch (error) { failed = true; failure = error; }
            let settlementFailed = false, settlementFailure: unknown;
            try { if (application) await settleApplication(); }
            catch (error) { settlementFailed = true; settlementFailure = error; }
            finally {
                const processErrors: unknown[] = [];
                // application.closed settles only after Core removes its owned listener.
                try { for (const signal of ["SIGINT", "SIGTERM"] as const) process.off(signal, stop); }
                catch (error) { addFailure(processErrors, error); }
                finally { clearInterval(processHold); }
                const errors: unknown[] = [];
                if (failed) addFailure(errors, failure);
                if (settlementFailed) addFailure(errors, settlementFailure);
                for (const error of runtimeFailures) addFailure(errors, error);
                for (const error of processErrors) addFailure(errors, error);
                failure = lifecycleFailure(runtimeFailures.length && settlementFailed ? "HTTP runtime and cleanup failed" : "Runtime and cleanup failed", errors);
                failed = errors.length > 0;
            }
            if (failed) throw failure;
            break;
        }
        case "dev": {
            const server = startDevServer(root, args.apiDirectory, args.port, args.projectFile, args.worker);
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
    console.error(error instanceof LifecycleError ? error : error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
