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
    for (const directory of [project.generatedRoot, project.apiDirectory, join(dirname(project.apiDirectory), "modules"), join(dirname(project.apiDirectory), "infra"), join(dirname(project.apiDirectory), "web")]) {
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
    const marker = join(outDir, ".boring-build.json");
    for (const reserved of [startup, marker]) {
        if ([...outputs.keys()].some(file => inside(reserved, file))) {
            throw new Error(`${relative(outDir, reserved)} is reserved for generated build files. Rename the conflicting source file or directory.`);
        }
    }
    const apiDirectory = relative(rootDir, project.apiDirectory).split(/[\\/]/).join("/");
    outputs.set(startup, `// Generated by boring build. Run with Node; no development tools are required.
const { join } = require("node:path");
const { BoringApi } = require("@boringapi/core");
const port = Number(process.env.PORT ?? 4040);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("PORT must be an integer between 0 and 65535");
}
new BoringApi().listen(join(__dirname, ${JSON.stringify(apiDirectory)}), port).catch(error => {
    console.error(error);
    process.exitCode = 1;
});
`);
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
