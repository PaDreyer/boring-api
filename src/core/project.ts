import { dirname } from "path";
import ts from "typescript";
import { generateTypes } from "./typegen";
import { architectureFiles, checkArchitecture } from "./architecture";

export function formatHost(root: string): ts.FormatDiagnosticsHost {
    return { getCanonicalFileName: file => file, getCurrentDirectory: () => root, getNewLine: () => ts.sys.newLine };
}

export function analyzeProject(root: string, apiDirectory: string) {
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
            throw new Error(ts.formatDiagnosticsWithColorAndContext([loaded.error], formatHost(root)));
        }
        const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, dirname(configFile), undefined, configFile);
        configDiagnostics.push(...parsed.errors);
        fileNames = parsed.fileNames;
        options = parsed.options;
    }

    fileNames = [...new Set([...fileNames, ...architectureFiles(generated.apiDirectory), ...generated.files])];
    options = {
        ...options,
        noEmit: true,
        allowJs: true,
        rootDir: undefined,
        rootDirs: [...(options.rootDirs ?? []), root, generated.generatedRoot],
    };

    const program = ts.createProgram({ rootNames: fileNames, options });
    const diagnostics = [...configDiagnostics, ...ts.getPreEmitDiagnostics(program)];
    const architecture = checkArchitecture(program, generated.apiDirectory, generated.generatedRoot);
    return { ...generated, projectRoot: root, program, diagnostics, architecture };
}

export type AnalyzedProject = ReturnType<typeof analyzeProject>;
