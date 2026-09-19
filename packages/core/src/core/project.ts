import ts from "typescript";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { generateTypes } from "./typegen";
import { architectureFiles, checkArchitecture } from "./architecture";
import { readConfiguration } from "./config";
import { aliasDiagnostics, compilerOptions } from "./compiler";
import { generateClientContracts } from "./clientgen";

export { formatHost } from "./config";

export function analyzeProject(root: string, apiDirectory: string, projectFile?: string) {
    const generated = generateTypes(root, apiDirectory);
    const configuration = readConfiguration(root, projectFile);
    const fileNames = [...new Set([...configuration.fileNames, ...architectureFiles(generated.apiDirectory), ...generated.files])];
    const options: ts.CompilerOptions = {
        ...compilerOptions(configuration.options, generated.apiDirectory, generated.clientFile),
        noEmit: true,
        allowJs: true,
        rootDir: undefined,
        rootDirs: [...(configuration.options.rootDirs ?? []), root, generated.generatedRoot],
    };

    let program = ts.createProgram({ rootNames: fileNames, options });
    if (existsSync(join(dirname(generated.apiDirectory), "web", "client"))) {
        const client = generateClientContracts(generated, program);
        generated.files.push(client);
        fileNames.push(client);
        program = ts.createProgram({ rootNames: fileNames, options, oldProgram: program });
    }
    const diagnostics = [...configuration.errors, ...ts.getPreEmitDiagnostics(program), ...aliasDiagnostics(program, configuration.options)];
    const architecture = checkArchitecture(program, generated.apiDirectory, generated.generatedRoot);
    return { ...generated, projectRoot: root, program, configuration, diagnostics, architecture };
}

export type AnalyzedProject = ReturnType<typeof analyzeProject>;
