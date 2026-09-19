import { realpathSync } from "fs";
import { builtinModules } from "module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";
import ts from "typescript";
import { serviceSources } from "./symbols";

export interface ArchitectureDiagnostic {
    code: "BORING101" | "BORING102" | "BORING103" | "BORING104" | "BORING105" | "BORING106" | "BORING107";
    file: ts.SourceFile;
    start: number;
    length: number;
    message: string;
}

type Area = {
    kind: "api" | "module" | "infra" | "browser" | "generated" | "framework" | "package" | "builtin" | "other";
    module?: string;
    entry?: "facade" | "schemas";
    name?: string;
};

interface Dependency {
    source: ts.SourceFile;
    node: ts.Node;
    specifier: string;
    typeOnly: boolean;
    target?: string;
    area: Area;
}

const extensions = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, "")));

function canonical(file: string): string {
    try { return realpathSync(file); }
    catch { return resolve(file); }
}

function inside(parent: string, file: string): boolean {
    const path = relative(parent, file);
    return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function roots(apiDirectory: string) {
    const api = canonical(apiDirectory);
    const parent = dirname(api);
    return {
        api,
        modules: canonical(join(parent, "modules")),
        infra: canonical(join(parent, "infra")),
        browser: canonical(join(parent, "web", "client")),
    };
}

/** Include unused application modules as well as dependencies reached from routes. */
export function architectureFiles(apiDirectory: string): string[] {
    return [...new Set(Object.values(roots(apiDirectory)).flatMap(directory =>
        ts.sys.directoryExists(directory)
            ? ts.sys.readDirectory(directory, extensions, ["**/node_modules/**", "**/.boring/**"])
            : []))].sort();
}

/** Analyze source and type information only; never load consumer modules. */
export function checkArchitecture(program: ts.Program, apiDirectory: string, generatedRoot: string): ArchitectureDiagnostic[] {
    const directories = roots(apiDirectory);
    const generated = canonical(generatedRoot);
    const frameworkEntries = new Set(["index.ts", "index.js", "index.d.ts"].map(name => canonical(join(__dirname, "..", name))));
    const checker = program.getTypeChecker();
    const cache = ts.createModuleResolutionCache(dirname(directories.api), file => file, program.getCompilerOptions());
    const diagnostics: ArchitectureDiagnostic[] = [];
    const sources = new Map(program.getSourceFiles().map(file => [canonical(file.fileName), file]));
    const dependencies = new Map<string, Dependency[]>();

    function area(file: string): Area {
        const target = canonical(file);
        if (inside(generated, target)) return { kind: "generated" };
        if (inside(directories.api, target)) return { kind: "api" };
        if (inside(directories.infra, target)) return { kind: "infra" };
        if (inside(directories.browser, target)) return { kind: "browser" };
        if (inside(directories.modules, target)) {
            const parts = relative(directories.modules, target).split(sep);
            const entry = parts.length === 2 && /^(facade|schemas)\.(?:d\.)?[cm]?[jt]sx?$/.exec(parts[1]);
            return { kind: "module", module: parts.length > 1 ? parts[0] : undefined,
                entry: entry ? entry[1] as "facade" | "schemas" : undefined };
        }
        if (frameworkEntries.has(target)) return { kind: "framework" };
        const packagePath = target.split(`${sep}node_modules${sep}`).pop();
        if (packagePath !== target) {
            const parts = packagePath!.split(sep);
            return { kind: "package", name: parts[0].startsWith("@") ? parts.slice(0, 2).join("/") : parts[0] };
        }
        return { kind: "other" };
    }

    function report(code: ArchitectureDiagnostic["code"], source: ts.SourceFile, node: ts.Node, message: string) {
        diagnostics.push({ code, file: source, start: node.getStart(source), length: node.getWidth(source), message });
    }

    function moduleReference(source: ts.SourceFile, node: ts.Node, typeOnly: boolean) {
        if (!ts.isStringLiteralLike(node)) {
            report("BORING106", source, node, "Module paths must be string literals. Use explicit imports so dependencies can be checked.");
            return;
        }
        const specifier = node.text;
        const builtin = specifier.replace(/^node:/, "");
        if (builtins.has(builtin)) {
            dependencies.get(canonical(source.fileName))!.push({ source, node, specifier, typeOnly,
                area: { kind: "builtin", name: builtin } });
            return;
        }
        const resolved = ts.resolveModuleName(specifier, source.fileName, program.getCompilerOptions(), ts.sys, cache).resolvedModule;
        if (!resolved) {
            report("BORING106", source, node, `Cannot resolve '${specifier}'. Install the dependency or fix its path; unchecked dependencies are not allowed.`);
            return;
        }
        const target = canonical(resolved.resolvedFileName);
        let targetArea = area(target);
        // Workspace packages can resolve outside node_modules after realpath.
        // Local convention files retain their role even if an alias names a package.
        if (targetArea.kind === "other" && resolved.packageId) {
            targetArea = { kind: "package", name: resolved.packageId.name };
        }
        dependencies.get(canonical(source.fileName))!.push({ source, node, specifier, typeOnly, target, area: targetArea });
    }

    function globalName(node: ts.Identifier, name: string): boolean {
        if (node.text !== name) return false;
        const declarations = checker.getSymbolAtLocation(node)?.declarations;
        return !declarations?.length || declarations.every(declaration => declaration.getSourceFile().isDeclarationFile);
    }

    function isRequire(node: ts.Node): boolean {
        if (ts.isIdentifier(node)) return globalName(node, "require");
        if (ts.isPropertyAccessExpression(node)) {
            return ts.isIdentifier(node.expression) && globalName(node.expression, "module") && node.name.text === "require";
        }
        return ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) &&
            globalName(node.expression, "module") && ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === "require";
    }

    function readDependencies(source: ts.SourceFile) {
        const key = canonical(source.fileName);
        if (dependencies.has(key)) return;
        dependencies.set(key, []);
        function visit(node: ts.Node) {
            if (ts.isImportDeclaration(node)) {
                moduleReference(source, node.moduleSpecifier, node.importClause?.isTypeOnly === true);
            } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
                moduleReference(source, node.moduleSpecifier, node.isTypeOnly);
            } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
                if (node.moduleReference.expression) moduleReference(source, node.moduleReference.expression, node.isTypeOnly);
            } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
                moduleReference(source, node.argument.literal, true);
            } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || isRequire(node.expression))) {
                if (node.arguments.length) moduleReference(source, node.arguments[0], false);
                else report("BORING106", source, node, "Module loading requires an explicit string literal path.");
            } else if (isRequire(node) && !(ts.isCallExpression(node.parent) && node.parent.expression === node)) {
                // Aliasing a loader would hide the paths from static analysis.
                if (!(ts.isIdentifier(node) && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) {
                    report("BORING106", source, node, "Do not alias or access module loaders. Use require('literal') or an explicit import.");
                }
            }
            ts.forEachChild(node, visit);
        }
        visit(source);
    }

    for (const file of architectureFiles(apiDirectory)) {
        const source = sources.get(canonical(file));
        if (source) readDependencies(source);
    }
    // TypeScript does not always add literal require() targets in .ts files to a
    // Program. Parse those sources too, so CommonJS barrels cannot hide edges.
    for (const edges of dependencies.values()) {
        for (const edge of edges) {
            if (!edge.target || !["api", "module", "infra", "browser", "other"].includes(edge.area.kind)) continue;
            if (dependencies.has(edge.target)) continue;
            let source = sources.get(edge.target);
            if (!source) {
                const text = ts.sys.readFile(edge.target);
                if (text === undefined) continue;
                source = ts.createSourceFile(edge.target, text, ts.ScriptTarget.Latest, true);
                sources.set(edge.target, source);
            }
            readDependencies(source);
        }
    }

    const operations = serviceSources(program, directories.api).flatMap(service => service.operations).flatMap(operation => {
        if (!operation.declaration) return [];
        const file = operation.declaration.getSourceFile();
        const line = file.getLineAndCharacterOfPosition(operation.declaration.getStart(file)).line + 1;
        return [`${operation.access} (${relative(dirname(directories.api), file.fileName)}:${line})`];
    });
    const servicesHint = operations.length ? `\nExisting public operations: ${operations.slice(0, 8).join(", ")}.` : "";
    for (const [file, edges] of dependencies) {
        const from = area(file);
        if (from.kind === "module" && !from.module) {
            const source = sources.get(file)!;
            report("BORING107", source, source, "Place module code in modules/<name>/, with facade.ts and schemas.ts as its public entry points.");
        }
        // Imported helpers outside the conventions cannot become an alternate
        // application layer. Their incoming edge is diagnosed below.
        if (from.kind === "other") continue;
        for (const edge of edges) {
            const to = edge.area;
            const fail = (code: ArchitectureDiagnostic["code"], message: string) => report(code, edge.source, edge.node, message);
            const framework = to.kind === "framework" || (to.kind === "package" && to.name === "@boringapi/core");
            const zod = to.kind === "package" && to.name === "zod";
            const endpoint = from.kind === "api" && /(?:^|[/\\])(get|post|put|patch|delete|head|options)\.[jt]s$/.test(file);
            const setup = file === join(directories.api, "+setup.ts") || file === join(directories.api, "+setup.js");

            if (from.kind === "api" && to.kind === "generated" && edge.typeOnly) {
                continue;
            } else if (!edge.typeOnly && to.kind === "builtin" && to.name === "module") {
                fail("BORING106", "Custom module loaders cannot be checked. Use explicit imports instead of node:module/createRequire.");
            } else if (to.kind === "api") {
                fail("BORING104", "Routes and hooks are entry points, not dependencies. Move shared behavior into a module facade or schemas.");
            } else if (to.kind === "module" && (!to.module || (!to.entry && (from.kind !== "module" || from.module !== to.module)))) {
                fail("BORING102", `Module internals are private: '${edge.specifier}'. Import the module's facade.ts or schemas.ts instead.`);
            } else if (from.kind === "browser" || (from.kind === "module" && from.entry === "schemas")) {
                const local = from.kind === "browser" && to.kind === "browser";
                const schema = to.kind === "module" && to.entry === "schemas";
                const external = to.kind === "package" && (from.kind === "browser" ? (!framework || edge.typeOnly) : zod);
                if (!(local || schema || external || (framework && edge.typeOnly))) {
                    fail("BORING105", `Browser code and shared schemas cannot import server code: '${edge.specifier}'. Share data through schemas.ts; use import type for framework-only types.`);
                }
            } else if (endpoint) {
                if (!(framework || zod || (to.kind === "module" && to.entry === "schemas") || (to.kind === "generated" && edge.typeOnly))) {
                    fail("BORING101", `Endpoints import only public schemas, generated types, @boringapi/core and zod. Move '${edge.specifier}' behind a facade exposed through ctx.services.${servicesHint}`);
                }
            } else if (from.kind === "api" && !setup && (to.kind === "infra" || (to.kind === "package" && !framework && !zod))) {
                fail("BORING101", "Initialize infrastructure and SDKs in +setup.ts and expose the required behavior through a facade.");
            } else if (from.kind === "infra" && to.kind === "module" && to.entry === "facade" && !edge.typeOnly) {
                fail("BORING104", "Infrastructure must not call business facades. Inject the adapter from +setup.ts; import type may describe its contract.");
            } else if (to.kind === "browser" || to.kind === "other" || to.kind === "generated") {
                fail("BORING107", `Dependency '${edge.specifier}' crosses the application structure. Use modules/<name>/facade.ts, schemas.ts or infra/ for shared server code.`);
            }
        }
    }

    // A module's private files form one unit. Follow infrastructure edges too,
    // so an adapter or barrel cannot conceal a dependency on another module.
    const moduleGraph = new Map<string, Map<string, Dependency>>();
    for (const [file, edges] of dependencies) {
        const from = area(file);
        if (from.kind !== "module" || !from.module) continue;
        const outgoing = moduleGraph.get(from.module) ?? new Map<string, Dependency>();
        moduleGraph.set(from.module, outgoing);
        const visited = new Set<string>();
        function follow(dependency: Dependency, origin: Dependency) {
            if (dependency.typeOnly || !dependency.target || visited.has(dependency.target)) return;
            visited.add(dependency.target);
            if (dependency.area.kind === "module" && dependency.area.module && dependency.area.module !== from.module) {
                if (!outgoing.has(dependency.area.module)) outgoing.set(dependency.area.module, origin);
            } else if (dependency.area.kind === "infra") {
                for (const next of dependencies.get(dependency.target) ?? []) follow(next, origin);
            }
        }
        for (const edge of edges) follow(edge, edge);
    }
    const visited = new Set<string>();
    const stack: string[] = [];
    function visitModule(module: string) {
        if (visited.has(module)) return;
        visited.add(module);
        stack.push(module);
        for (const [target, edge] of [...(moduleGraph.get(module) ?? [])].sort(([a], [b]) => a.localeCompare(b))) {
            const index = stack.indexOf(target);
            if (index !== -1) {
                report("BORING103", edge.source, edge.node,
                    `Module dependency cycle: ${[...stack.slice(index), target].join(" -> ")}. Move shared contracts into schemas or put orchestration in a separate module.`);
            } else visitModule(target);
        }
        stack.pop();
    }
    for (const module of [...moduleGraph.keys()].sort()) visitModule(module);

    return diagnostics.sort((a, b) => a.file.fileName.localeCompare(b.file.fileName) || a.start - b.start || a.code.localeCompare(b.code));
}

export function formatArchitectureDiagnostics(diagnostics: ArchitectureDiagnostic[], projectRoot: string): string {
    return diagnostics.map(diagnostic => {
        const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
        return `${relative(projectRoot, diagnostic.file.fileName)}:${line + 1}:${character + 1} - error ${diagnostic.code}: ${diagnostic.message}`;
    }).join("\n");
}
