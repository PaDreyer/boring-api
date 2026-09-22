import ts from "typescript";
import { existsSync, realpathSync } from "fs";
import { dirname, join, resolve } from "path";
import { generateTypes, generateClientContracts } from "@boringapi/typegen";
import { architectureFiles, analyzeArchitecture } from "./architecture";
import { aliasDiagnostics, compilerOptions, readConfiguration } from "@boringapi/compiler";

/** Refresh browser contracts with type analysis only when the application uses them. */
export function synchronizeProject(root: string, apiDirectory: string, projectFile?: string) {
    return existsSync(join(dirname(resolve(root, apiDirectory)), "web", "client"))
        ? analyzeProject(root, apiDirectory, projectFile) : generateTypes(root, apiDirectory);
}

export function analyzeProject(root: string, apiDirectory: string, projectFile?: string) {
    // Typegen already resolves the consumer root before applying its containment
    // checks. Keep the compiler, architecture model, inspection and build on that
    // same physical root when callers enter a project through a symlink (including
    // macOS' /var -> /private/var temporary-directory alias).
    const projectRoot = realpathSync(resolve(root));
    const generated = generateTypes(projectRoot, apiDirectory);
    const requestedProjectFile = projectFile && resolve(projectRoot, projectFile);
    const configuration = readConfiguration(projectRoot, requestedProjectFile && existsSync(requestedProjectFile)
        ? realpathSync(requestedProjectFile) : projectFile);
    const fileNames = [...new Set([...configuration.fileNames, ...architectureFiles(generated.apiDirectory), ...generated.files])];
    const options: ts.CompilerOptions = {
        ...compilerOptions(configuration.options, generated.apiDirectory, generated.clientFile),
        noEmit: true,
        allowJs: true,
        rootDir: undefined,
        rootDirs: [...(configuration.options.rootDirs ?? []), projectRoot, generated.generatedRoot],
    };

    let program = ts.createProgram({ rootNames: fileNames, options });
    if (existsSync(join(dirname(generated.apiDirectory), "web", "client"))) {
        const client = generateClientContracts(generated, program);
        generated.files.push(client);
        fileNames.push(client);
        program = ts.createProgram({ rootNames: fileNames, options, oldProgram: program });
    }
    const diagnostics = [...configuration.errors, ...ts.getPreEmitDiagnostics(program), ...aliasDiagnostics(program, configuration.options)];
    const model = analyzeArchitecture(program, generated.apiDirectory, generated.generatedRoot);
    return { ...generated, projectRoot, program, configuration, diagnostics, architecture: model.diagnostics, roles: model.sources };
}

export type AnalyzedProject = ReturnType<typeof analyzeProject>;
