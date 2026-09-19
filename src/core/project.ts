import ts from "typescript";
import { generateTypes } from "./typegen";
import { architectureFiles, checkArchitecture } from "./architecture";
import { readConfiguration } from "./config";
import { aliasDiagnostics, compilerOptions } from "./compiler";

export { formatHost } from "./config";

export function analyzeProject(root: string, apiDirectory: string, projectFile?: string) {
    const generated = generateTypes(root, apiDirectory);
    const configuration = readConfiguration(root, projectFile);
    const fileNames = [...new Set([...configuration.fileNames, ...architectureFiles(generated.apiDirectory), ...generated.files])];
    const options: ts.CompilerOptions = {
        ...compilerOptions(configuration.options, generated.apiDirectory),
        noEmit: true,
        allowJs: true,
        rootDir: undefined,
        rootDirs: [...(configuration.options.rootDirs ?? []), root, generated.generatedRoot],
    };

    const program = ts.createProgram({ rootNames: fileNames, options });
    const diagnostics = [...configuration.errors, ...ts.getPreEmitDiagnostics(program), ...aliasDiagnostics(program, configuration.options)];
    const architecture = checkArchitecture(program, generated.apiDirectory, generated.generatedRoot);
    return { ...generated, projectRoot: root, program, configuration, diagnostics, architecture };
}

export type AnalyzedProject = ReturnType<typeof analyzeProject>;
