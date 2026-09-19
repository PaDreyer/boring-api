import { readFileSync, realpathSync } from "fs";
import { dirname, isAbsolute } from "path";
import ts from "typescript";
import { register } from "ts-node";
import { compilerOptions, importTransformer } from "./compiler";
import { formatHost, readConfiguration } from "./config";

/** Register the source compiler before importing application modules in a custom server or test runner. */
export function registerTypeScript(apiDirectory: string, projectFile?: string): () => void {
    if (!isAbsolute(apiDirectory)) throw new Error("registerTypeScript requires an absolute API directory.");
    const api = realpathSync(apiDirectory);
    const root = dirname(api);
    const configuration = readConfiguration(root, projectFile);
    if (configuration.errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(configuration.errors, formatHost(root)));
    const options = compilerOptions(configuration.options, api);
    if (options.module !== undefined && options.module !== ts.ModuleKind.CommonJS) throw new Error("The Boring API source compiler requires compilerOptions.module = commonjs.");
    const transformer = importTransformer({ options });
    const extensions = [".ts", ".tsx", ".js", ".jsx", ".cts", ".cjs"];
    const previous = new Map(extensions.map(extension => [extension, require.extensions[extension]]));
    const service = register({
        cwd: root, project: configuration.options.configFilePath as string | undefined,
        skipProject: !configuration.options.configFilePath, transpileOnly: true, scope: true, scopeDir: root,
        compilerOptions: {
            target: ts.ScriptTarget[options.target ?? ts.ScriptTarget.ES2020], module: "commonjs",
            esModuleInterop: options.esModuleInterop, allowJs: true, sourceMap: true, noEmit: false,
        },
        transformers: { before: [transformer as ts.TransformerFactory<ts.SourceFile>] },
    });
    // Select one compiler for a file. Chaining ts-node registrations would let an
    // earlier, unrelated project's typechecker process the original source first.
    const handlers = new Map<string, NodeJS.RequireExtensions[string]>();
    for (const extension of extensions) {
        const fallback = previous.get(extension) ?? previous.get(".js")!;
        const handler: NodeJS.RequireExtensions[string] = (module, file) => {
            if (service.ignored(file)) return fallback(module, file);
            const compiled = service.compile(readFileSync(file, "utf8"), file);
            (module as NodeModule & { _compile(code: string, file: string): void })._compile(compiled, file);
        };
        handlers.set(extension, handler);
        require.extensions[extension] = handler;
    }
    return () => {
        service.enabled(false);
        for (const [extension, handler] of handlers) {
            if (require.extensions[extension] !== handler) continue;
            const old = previous.get(extension);
            if (old) require.extensions[extension] = old;
            else delete require.extensions[extension];
        }
    };
}
