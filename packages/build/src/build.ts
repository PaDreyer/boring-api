import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import ts from "typescript";
import { compilerOptions, emittedPath, importTransformer, inside } from "@boringapi/compiler";
import { AnalyzedProject } from "@boringapi/analyzer";

function safeOutput(root: string, output: string): void {
    if (output === root || !inside(root, output)) throw new Error("Build output must be a directory inside the consumer project.");
    let current = root;
    for (const part of relative(root, output).split(/[\\/]/)) {
        current = join(current, part);
        try {
            if (lstatSync(current).isSymbolicLink()) throw new Error(`Build output must not contain symbolic links: ${current}`);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
    }
}

/** Shared process ownership used by every generated production bootstrap. */
function processLifecycle(): string {
    return `let application;
let stopping = false;
let closing;
let signalReceived;
const stopped = new Promise(resolve => { signalReceived = resolve; });
const cancellation = new AbortController();
// A pending Promise does not retain Node. Hold the process from bootstrap entry
// through final lifecycle settlement; the supervisor owns the final SIGKILL.
const processHold = setInterval(() => {}, 2147483647);
async function closeApplication(owner) {
    const errors = [];
    try { await owner.close(); }
    catch (error) { addFailure(errors, error); }
    // close() has a bounded caller wait. Actual settlement and cleanup do not.
    try { await owner.closed; }
    catch (error) { addFailure(errors, error); }
    if (errors.length) throw lifecycleFailure("Shutdown wait and eventual cleanup failed", errors);
}
function settleApplication() {
    if (!application) return Promise.resolve();
    // Publish the shared Promise before close() can synchronously re-enter stop().
    if (!closing) {
        const owner = application;
        closing = Promise.resolve().then(() => closeApplication(owner));
    }
    return closing;
}
function addFailure(errors, error) {
    if (!errors.includes(error)) errors.push(error);
}
function lifecycleFailure(message, errors) {
    if (!errors.length) return undefined;
    if (errors.length === 1) return errors[0];
    const combined = new LifecycleError(message, errors);
    return combined.errors.length === 1 ? combined.errors[0] : combined;
}
const stop = () => {
    stopping = true;
    cancellation.abort();
    signalReceived();
    // The main lifecycle below awaits and reports this shared cleanup exactly once.
    if (application) void settleApplication().catch(() => {});
};
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, stop);
function removeSignals() {
    try { for (const signal of ["SIGINT", "SIGTERM"]) process.off(signal, stop); }
    finally { clearInterval(processHold); }
}`;
}

/** Emit a checked consumer application. The package itself is still built by tsc. */
export function buildProject(project: AnalyzedProject): { diagnostics: readonly ts.Diagnostic[]; output: string } {
    if (project.diagnostics.length || project.architecture.length) throw new Error("Cannot build a project with check errors.");
    const root = realpathSync(project.projectRoot);
    const configured = project.configuration.options;
    const rootDir = resolve(configured.rootDir ?? dirname(project.apiDirectory));
    const outDir = resolve(configured.outDir ?? join(root, "dist"));
    safeOutput(root, outDir);
    const reference = join(root, ".boring", "build.json");
    safeOutput(root, reference);
    if (inside(outDir, reference) || inside(reference, outDir)) throw new Error("Build output overlaps the reserved build reference .boring/build.json.");
    if (existsSync(reference) && !lstatSync(reference).isFile()) throw new Error("The build reference .boring/build.json must be a regular file.");
    if (configured.module !== undefined && configured.module !== ts.ModuleKind.CommonJS) throw new Error("boring build currently requires compilerOptions.module = commonjs.");
    if (configured.outFile || configured.declarationDir || configured.composite || configured.incremental || configured.emitDeclarationOnly) {
        throw new Error("boring build uses a single output directory; outFile, declarationDir, composite, incremental and emitDeclarationOnly are unsupported.");
    }
    for (const directory of [project.generatedRoot, project.apiDirectory, join(dirname(project.apiDirectory), "modules"), join(dirname(project.apiDirectory), "infra"), join(dirname(project.apiDirectory), "web"), join(dirname(project.apiDirectory), "executions"), join(dirname(project.apiDirectory), "jobs"), ...["schedules", "events", "commands"].map(name => join(dirname(project.apiDirectory), name))]) {
        if (inside(directory, outDir) || inside(outDir, directory)) throw new Error(`Build output overlaps application or generated source: ${directory}`);
    }
    const files = project.program.getRootFileNames().filter(file => !inside(project.generatedRoot, file));
    for (const source of project.program.getSourceFiles()) {
        if (!source.isDeclarationFile && !inside(project.generatedRoot, source.fileName) && inside(outDir, source.fileName)) {
            throw new Error(`Build output contains source: ${source.fileName}`);
        }
    }
    const options: ts.CompilerOptions = {
        ...compilerOptions(configured, project.apiDirectory, project.clientFile), module: ts.ModuleKind.CommonJS,
        rootDir, outDir, noEmit: false, noEmitOnError: true, allowJs: true,
        rootDirs: project.program.getCompilerOptions().rootDirs,
    };
    const program = ts.createProgram(files, options);
    const diagnostics = ts.getPreEmitDiagnostics(program);
    if (diagnostics.length) return { diagnostics, output: outDir };

    const outputFile = (file: string) => {
        const original = inside(project.generatedRoot, file) ? join(root, relative(project.generatedRoot, file)) : file;
        return emittedPath(original, rootDir, outDir, options);
    };
    const outputs = new Map<string, string>();
    const result = program.emit(undefined, (file, text) => outputs.set(resolve(file), text), undefined, false, {
        before: [importTransformer({ options, outputFile }) as ts.TransformerFactory<ts.SourceFile>],
        afterDeclarations: [importTransformer({ options, outputFile, relocateRelative: true })],
    });
    if (result.emitSkipped || result.diagnostics.length) return { diagnostics: result.diagnostics, output: outDir };

    if (options.declaration) {
        const declarations = new Set([
            ...project.files.filter(file => file.endsWith(".d.ts")),
            ...program.getSourceFiles().filter(source => source.isDeclarationFile && inside(rootDir, source.fileName) &&
                !program.isSourceFileFromExternalLibrary(source) && !source.fileName.split(/[\\/]/).includes("node_modules"))
                .map(source => source.fileName),
        ]);
        for (const file of declarations) {
            const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
            const transformed = ts.transform(source, [importTransformer({ options, outputFile, relocateRelative: true })]);
            try {
                outputs.set(outputFile(file).replace(/\.([cm]?)js$/, ".d.$1ts"), ts.createPrinter().printFile(transformed.transformed[0] as ts.SourceFile));
            } finally { transformed.dispose(); }
        }
    }
    const startup = join(outDir, "boring-start.cjs");
    const worker = join(outDir, "boring-worker.cjs");
    const marker = join(outDir, ".boring-build.json");
    const processModes = [["scheduler", "scheduler"], ["schedule-worker", "schedule"], ["consumer", "event"], ["publisher", "publication"], ["command", "command"]] as const;
    const triggers = processModes.map(([name]) => join(outDir, `boring-${name}.cjs`));
    for (const reserved of [startup, worker, marker, ...triggers]) {
        if ([...outputs.keys()].some(file => inside(reserved, file))) {
            throw new Error(`${relative(outDir, reserved)} is reserved for generated build files. Rename the conflicting source file or directory.`);
        }
    }
    const apiDirectory = relative(rootDir, project.apiDirectory).split(/[\\/]/).join("/");
    outputs.set(startup, `// Generated by boring build. Run with Node; no development tools are required.
const { join } = require("node:path");
const { BoringApi, ExecutionError, LifecycleError } = require("@boringapi/core");
const port = Number(process.env.PORT ?? 4040);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("PORT must be an integer between 0 and 65535");
}
${processLifecycle()}
let runtimeServer;
const runtimeFailures = [];
const runtimeError = error => {
    addFailure(runtimeFailures, error);
    stop();
};
(async () => {
    let failure;
    let failed = false;
    try {
        application = await new BoringApi().createApp(join(__dirname, ${JSON.stringify(apiDirectory)}));
        if (!stopping) {
            let server;
            try {
                server = await application.listen(port, undefined, runtimeError);
            } catch (error) {
                // Core uses unavailable only when shutdown interrupts listener admission.
                // This classification is intentionally scoped to the listen call.
                if (!(stopping && error instanceof ExecutionError && error.code === "unavailable")) throw error;
            }
            if (server) {
                runtimeServer = server;
                const address = server.address();
                console.info(\`Listening on port \${typeof address === "object" && address ? address.port : port}\`);
                await stopped;
            }
        }
    } catch (error) { failed = true; failure = error; }
    let settlementFailure;
    let settlementFailed = false;
    try { if (application) await settleApplication(); }
    catch (error) { settlementFailed = true; settlementFailure = error; }
    finally {
        const errors = [];
        if (failed) addFailure(errors, failure);
        if (settlementFailed) addFailure(errors, settlementFailure);
        // application.closed settles only after Core removes its owned listener.
        removeSignals();
        for (const error of runtimeFailures) addFailure(errors, error);
        failure = lifecycleFailure(runtimeFailures.length && settlementFailed ? "HTTP runtime and cleanup failed" : "Startup and cleanup failed", errors);
        failed = errors.length > 0;
    }
    if (failed) { console.error(failure); process.exitCode = 1; }
})().catch(error => { console.error(error); process.exitCode = 1; });
`);
    outputs.set(worker, `// Generated by boring build. Independent worker; no HTTP listener or development tools.
const { join } = require("node:path");
const { BoringApi, LifecycleError } = require("@boringapi/core");
${processLifecycle()}
(async () => {
    let failure;
    try {
        application = await new BoringApi().createApp(join(__dirname, ${JSON.stringify(apiDirectory)}));
        if (!stopping) await application.work();
    } catch (error) { failure = error; }
    try { if (application) await settleApplication(); }
    catch (error) { failure = failure ? new LifecycleError("Execution and cleanup failed", [failure, error]) : error; }
    finally { removeSignals(); }
    if (failure) { console.error(failure); process.exitCode = 1; }
})().catch(error => { console.error(error); process.exitCode = 1; });
`);
    for (const [index, file] of triggers.entries()) {
        const mode = processModes[index][1];
        outputs.set(file, `// Generated by boring build. Compiler-free ${mode} bootstrap.
const { join } = require("node:path");
const { BoringApi, commandFailure, LifecycleError } = require("@boringapi/core");
${processLifecycle()}
function structuredFailure(error) {
    const description = commandFailure(error);
    function cause(value) {
        return {
            name: value instanceof Error ? value.name : "Error",
            message: value instanceof Error ? value.message : String(value),
            ...(value && typeof value === "object" && typeof value.code === "string" ? { code: value.code } : {}),
            ...(value instanceof LifecycleError ? { causes: value.errors.map(cause) } : {}),
        };
    }
    return { exitCode: description.exitCode, error: {
        ...description.error,
        ...(error instanceof LifecycleError ? { causes: error.errors.map(cause) } : {}),
    } };
}
(async () => {
    let result;
    let failed = false;
    let failure;
    try {
        ${mode === "command" ? `if (process.argv.length !== 4) throw new SyntaxError("Usage: node boring-command.cjs <name> '<JSON input>'");
        const input = JSON.parse(process.argv[3]);` : ""}
        application = await new BoringApi().createApp(join(__dirname, ${JSON.stringify(apiDirectory)}));
        if (!stopping) {
            ${mode === "command" ? 'result = await application.command(process.argv[2], input, { signal: cancellation.signal });' : mode === "scheduler" ? 'await application.schedule();' : `await application.work({ kind: ${JSON.stringify(mode)} });`}
        }
    } catch (error) {
        failed = true; failure = error;
    } finally {
        try { if (application) await settleApplication(); }
        catch (error) { failure = failed ? new LifecycleError("Execution and cleanup failed", [failure, error]) : error; failed = true; }
        finally { removeSignals(); }
    }
    if (failed) {
        const description = structuredFailure(failure);
        console.error(JSON.stringify({ error: description.error })); process.exitCode = description.exitCode;
    } else if (!stopping) { ${mode === "command" ? 'console.log(JSON.stringify(result));' : ''} }
    if (stopping && !process.exitCode) process.exitCode = ${mode === "command" ? 130 : 0};
})().catch(error => { const failure = structuredFailure(error); console.error(JSON.stringify({error:failure.error})); process.exitCode = failure.exitCode; });
`);
    }
    for (const file of outputs.keys()) {
        if (!inside(outDir, file)) throw new Error(`Compiler output escapes outDir: ${file}`);
        safeOutput(root, file);
    }
    // Only replace an output directory previously owned by this build command.
    // Compilation finishes successfully in memory before touching an existing build.
    if (existsSync(outDir) && readdirSync(outDir).length) {
        let owner: unknown;
        if (existsSync(marker) && !lstatSync(marker).isSymbolicLink()) {
            try { owner = JSON.parse(readFileSync(marker, "utf8")); } catch { /* Not owned build output. */ }
        }
        if (!owner || typeof owner !== "object" || !("api" in owner) || owner.api !== project.apiDirectory) {
            throw new Error(`Output directory is not owned by boring build: ${outDir}. Choose an empty outDir.`);
        }
        rmSync(outDir, { recursive: true });
    }
    mkdirSync(outDir, { recursive: true });
    for (const [file, content] of outputs) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, content);
    }
    writeFileSync(marker, JSON.stringify({ version: 1, api: project.apiDirectory,
        apiDirectory }));
    mkdirSync(dirname(reference), { recursive: true });
    writeFileSync(reference, JSON.stringify({ version: 1, outputDirectory: relative(root, outDir).split(/[\\/]/).join("/") }));
    return { diagnostics: [], output: outDir };
}
