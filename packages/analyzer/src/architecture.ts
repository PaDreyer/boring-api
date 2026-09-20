import { builtinModules } from "module";
import { basename, dirname, join, relative, sep } from "path";
import ts from "typescript";
import { serviceSources } from "./services";
import { applicationRole, allowsModuleDependency, applicationDirectories as roots, canonicalPath as canonical, withinDirectory as inside } from "@boringapi/core/conventions";
import { checkBoundaries } from "./boundaries";
import { typeOnlyDependency } from "./type-dependencies";

export interface ArchitectureDiagnostic {
    code: "BORING101" | "BORING102" | "BORING103" | "BORING104" | "BORING105" | "BORING106" | "BORING107" | "BORING109" | "BORING110" | "BORING111" | "BORING112" | "BORING113" | "BORING114" | "BORING115" | "BORING116";
    file: ts.SourceFile;
    start: number;
    length: number;
    message: string;
}

type Area = {
    kind: "api" | "job" | "execution" | "module" | "infra" | "browser" | "pages" | "generated" | "client" | "framework" | "package" | "builtin" | "other";
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
const toolingPackages = new Set(["compiler", "typegen", "analyzer", "build", "scaffold", "dev", "cli"].map(name => `@boringapi/${name}`));

/** Include unused application modules as well as dependencies reached from routes. */
export function architectureFiles(apiDirectory: string): string[] {
    return [...new Set(Object.values(roots(apiDirectory)).flatMap(directory =>
        ts.sys.directoryExists(directory)
            ? ts.sys.readDirectory(directory, extensions, ["**/node_modules/**", "**/.boring/**"])
            : []))].sort();
}

/** Analyze source and type information only; never load consumer modules. */
export function analyzeArchitecture(program: ts.Program, apiDirectory: string, generatedRoot: string) {
    const directories = roots(apiDirectory);
    const generated = canonical(generatedRoot);
    const entries = (specifier: string) => {
        const runtime = require.resolve(specifier);
        return new Set([runtime, runtime.replace(/\.js$/, ".d.ts")].map(canonical));
    };
    const frameworkEntries = new Set([...entries("@boringapi/core"), ...entries("@boringapi/core/conventions")]);
    const clientEntries = entries("@boringapi/core/client");
    const packageNames = new Map<string, string | undefined>();
    // Resolve paths aliases and workspace symlinks from metadata, without loading
    // tooling packages or introducing reverse dependencies on their implementations.
    const packageName = (directory: string): string | undefined => {
        if (packageNames.has(directory)) return packageNames.get(directory);
        const manifest = ts.sys.readFile(join(directory, "package.json"));
        const parent = dirname(directory);
        let name: string | undefined;
        if (manifest) {
            try { name = JSON.parse(manifest).name; } catch { /* The compiler reports invalid package metadata. */ }
        } else if (parent !== directory) name = packageName(parent);
        packageNames.set(directory, name);
        return name;
    };
    const checker = program.getTypeChecker();
    const cache = ts.createModuleResolutionCache(dirname(directories.api), file => file, program.getCompilerOptions());
    const diagnostics: ArchitectureDiagnostic[] = [];
    const sources = new Map(program.getSourceFiles().map(file => [canonical(file.fileName), file]));
    const dependencies = new Map<string, Dependency[]>();

    function area(file: string): Area {
        const target = canonical(file);
        if (clientEntries.has(target)) return { kind: "client" };
        if (inside(generated, target)) return { kind: "generated" };
        if (inside(directories.jobs, target)) return { kind: "job" };
        if (inside(directories.executions, target)) return { kind: "execution" };
        if (inside(directories.api, target)) return { kind: "api" };
        if (inside(directories.infra, target)) return { kind: "infra" };
        if (inside(directories.browser, target)) return { kind: "browser" };
        if (inside(directories.pages, target)) return { kind: "pages" };
        if (inside(directories.modules, target)) {
            const entry = applicationRole(apiDirectory, target);
            return { kind: "module", module: entry.module,
                entry: entry.public && (entry.role === "facade" || entry.role === "schemas") ? entry.role : undefined };
        }
        if (frameworkEntries.has(target)) return { kind: "framework" };
        const name = packageName(dirname(target));
        if (name && toolingPackages.has(name)) return { kind: "package", name };
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
                moduleReference(source, node.moduleSpecifier, typeOnlyDependency(node));
            } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
                moduleReference(source, node.moduleSpecifier, typeOnlyDependency(node));
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
            if (!edge.target || !["api", "job", "execution", "module", "infra", "browser", "pages", "other"].includes(edge.area.kind)) continue;
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
        const fromRole = applicationRole(apiDirectory, file);
        if ((from.kind === "module" || from.kind === "api") && fromRole.role === "unknown") {
            const source = sources.get(file)!;
            report("BORING107", source, source, "Unclassified application source. Use facade.ts/facade/, service.ts/services/, schemas.ts/schemas/ or ports/ inside modules/<name>; helpers and internal directories have no implicit permissions.");
        }
        // Imported helpers outside the conventions cannot become an alternate
        // application layer. Their incoming edge is diagnosed below.
        if (from.kind === "other") continue;
        for (const edge of edges) {
            const to = edge.area;
            const toRole = edge.target ? applicationRole(apiDirectory, edge.target) : undefined;
            const fail = (code: ArchitectureDiagnostic["code"], message: string) => report(code, edge.source, edge.node, message);
            const framework = to.kind === "framework" || (to.kind === "package" && to.name === "@boringapi/core");
            const tooling = to.kind === "package" && toolingPackages.has(to.name!);
            const zod = to.kind === "package" && to.name === "zod";
            const endpoint = fromRole.role === "endpoint" || fromRole.role === "execution" || fromRole.role === "job";
            const setup = fromRole.role === "setup";

            if ((from.kind === "api" || from.kind === "execution" || from.kind === "job") && to.kind === "generated" && edge.typeOnly) {
                continue;
            } else if (fromRole.role === "job" && framework && !edge.typeOnly) {
                const declaration = edge.node.parent;
                const bindings = ts.isImportDeclaration(declaration) && declaration.importClause?.namedBindings;
                if (!bindings || !ts.isNamedImports(bindings) || declaration.importClause?.name ||
                    bindings.elements.some(entry => !entry.isTypeOnly && !["ApplicationError", "JobError", "requirePermissions"].includes((entry.propertyName ?? entry.name).text))) {
                    fail("BORING116", "Jobs import Core types or named ApplicationError, JobError and requirePermissions only. Application construction, execution admission and job binding belong to bootstrap/setup; namespace, CommonJS and lazy Core runtime imports are unsupported in jobs.");
                }
            } else if (!edge.typeOnly && to.kind === "builtin" && to.name === "module") {
                fail("BORING106", "Custom module loaders cannot be checked. Use explicit imports instead of node:module/createRequire.");
            } else if ((to.kind === "execution" || to.kind === "job")) {
                fail("BORING104", "Controlled execution entries are called by bootstrap, not imported by application roles.");
            } else if (fromRole.role === "config" && !(zod || framework && edge.typeOnly || toRole?.role === "schemas" && toRole.public)) {
                fail("BORING115", "Configuration imports only Zod, public schemas and Core types. Read the supplied environment; construct dependencies in setup.");
            } else if (to.kind === "api") {
                fail("BORING104", "Routes and hooks are entry points, not dependencies. Move shared behavior into a module facade or schemas.");
            } else if (toRole?.role === "service" && fromRole.role === "facade" && fromRole.module === toRole.module &&
                (!ts.isImportDeclaration(edge.node.parent) && !ts.isExportDeclaration(edge.node.parent) ||
                    ts.isImportDeclaration(edge.node.parent) && !!edge.node.parent.importClause?.namedBindings &&
                    ts.isNamespaceImport(edge.node.parent.importClause.namedBindings))) {
                fail("BORING114", "Service references require explicit named ES imports so calls and value escapes can be checked. CommonJS and lazy service loading are unsupported.");
            } else if (to.kind === "module" && toRole && !allowsModuleDependency(fromRole, toRole, edge.typeOnly)) {
                const code = from.kind === "browser" || fromRole.role === "schemas" ? "BORING105" :
                    toRole.role === "facade" && from.kind === "infra" ? "BORING104" : endpoint && toRole.role === "facade" ? "BORING101" : "BORING102";
                fail(code, `${fromRole.role} cannot import ${toRole.role} '${edge.specifier}'. Only the owning facade calls services; adapters/setup import port types, and callers reuse public facade operations.${servicesHint}`);
            } else if (from.kind === "browser" || fromRole.role === "schemas") {
                const local = from.kind === "browser" && to.kind === "browser";
                const schema = toRole?.role === "schemas";
                const client = from.kind === "browser" && (to.kind === "client" ||
                    to.kind === "package" && to.name === "@boringapi/core" && edge.specifier === "@boringapi/core/client" ||
                    to.kind === "generated" && edge.typeOnly && edge.target !== undefined && basename(edge.target) === "$client.d.ts");
                const external = to.kind === "package" && (from.kind === "browser" ? (!(framework || tooling) || edge.typeOnly) : zod);
                if (!(local || schema || external || client || (framework && edge.typeOnly))) {
                    fail("BORING105", `Browser code and shared schemas cannot import server code: '${edge.specifier}'. Share data through schemas.ts; use import type for framework-only types.`);
                }
            } else if (from.kind === "module") {
                const local = to.kind === "module" && toRole && allowsModuleDependency(fromRole, toRole, edge.typeOnly);
                const core = framework && (fromRole.role === "facade" || edge.typeOnly);
                if (!(local || zod && fromRole.role !== "port" || core)) {
                    fail("BORING110", `${fromRole.role} cannot import '${edge.specifier}'. Business code uses injected port contracts; concrete infrastructure, packages and Node APIs belong in infra/.`);
                }
            } else if (endpoint) {
                if (!(framework || zod || (to.kind === "module" && to.entry === "schemas") || (to.kind === "generated" && edge.typeOnly))) {
                    fail("BORING101", `Endpoints import only public schemas, generated types, @boringapi/core and zod. Move '${edge.specifier}' behind a facade exposed through ctx.services.${servicesHint}`);
                }
            } else if (from.kind === "pages") {
                if (!(to.kind === "pages" || to.kind === "module" && !!to.entry || framework || zod)) {
                    fail("BORING109", "Server pages use public facades and schemas. Initialize infrastructure in +setup and inject the existing business operations.");
                }
            } else if (to.kind === "pages" && !setup) {
                fail("BORING109", "Server pages are presentation adapters. Only +setup wires them; business modules and infrastructure must not depend on pages.");
            } else if (from.kind === "api" && !setup && (to.kind === "infra" || (to.kind === "package" && !framework && !zod))) {
                fail("BORING101", "Initialize infrastructure and SDKs in +setup.ts and expose the required behavior through a facade.");
            } else if (from.kind === "infra" && to.kind === "module" && to.entry === "facade") {
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

    diagnostics.push(...checkBoundaries(program, apiDirectory, [...dependencies.keys()].flatMap(file => sources.get(file) ? [sources.get(file)!] : [])));
    return {
        diagnostics: diagnostics.sort((a, b) => a.file.fileName.localeCompare(b.file.fileName) || a.start - b.start || a.code.localeCompare(b.code)),
        sources: [...dependencies].filter(([file]) => area(file).kind !== "other").map(([file, edges]) => ({
            file, ...applicationRole(apiDirectory, file),
            dependencies: edges.map(edge => ({ specifier: edge.specifier, file: edge.target, typeOnly: edge.typeOnly,
                role: edge.target ? applicationRole(apiDirectory, edge.target).role : edge.area.kind,
                start: edge.node.getStart(edge.source) })),
        })).sort((a, b) => a.file.localeCompare(b.file)),
    };
}

export function formatArchitectureDiagnostics(diagnostics: ArchitectureDiagnostic[], projectRoot: string): string {
    return diagnostics.map(diagnostic => {
        const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
        return `${relative(projectRoot, diagnostic.file.fileName)}:${line + 1}:${character + 1} - error ${diagnostic.code}: ${diagnostic.message}`;
    }).join("\n");
}

export function checkArchitecture(program: ts.Program, apiDirectory: string, generatedRoot: string): ArchitectureDiagnostic[] {
    return analyzeArchitecture(program, apiDirectory, generatedRoot).diagnostics;
}
