import { dirname, resolve } from "path";
import ts from "typescript";

export function formatHost(root: string): ts.FormatDiagnosticsHost {
    return { getCanonicalFileName: file => file, getCurrentDirectory: () => root, getNewLine: () => ts.sys.newLine };
}

export function readConfiguration(root: string, projectFile?: string): ts.ParsedCommandLine {
    const file = projectFile ? resolve(root, projectFile) : ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json");
    if (!file) return { options: {
        target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS,
        moduleResolution: ts.ModuleResolutionKind.NodeJs, esModuleInterop: true, strict: true, skipLibCheck: true,
        outDir: resolve(root, "dist"),
    }, fileNames: [], errors: [] };
    const loaded = ts.readConfigFile(file, ts.sys.readFile);
    if (loaded.error) throw new Error(ts.formatDiagnosticsWithColorAndContext([loaded.error], formatHost(root)));
    const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, dirname(file), undefined, file);
    // TypeScript excludes outDir from its default file search. Apply our default
    // before that search too, so a subsequent check/build cannot ingest its output.
    return parsed.options.outDir !== undefined || parsed.errors.length ? parsed : ts.parseJsonConfigFileContent(
        { ...loaded.config, compilerOptions: { ...loaded.config.compilerOptions, outDir: resolve(root, "dist") } },
        ts.sys, dirname(file), undefined, file,
    );
}
