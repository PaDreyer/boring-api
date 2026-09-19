import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from "fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "path";
import ts from "typescript";
import { analyzeProject, AnalyzedProject, formatArchitectureDiagnostics, inspectProject } from "@boringapi/analyzer";
import { formatHost, inside, moduleLiteral, resolveImport } from "@boringapi/compiler";
import { endpointSegment, HTTP_METHODS, RouteSource, SourceScope } from "@boringapi/core/conventions";
import { consumerScripts, consumerTemplates, endpointTemplate, factoryName, moduleTemplate } from "./templates";
import { generateTypes } from "@boringapi/typegen";

interface Change { file: string; content: string; before?: string; }
export interface ScaffoldResult { files: string[]; notes: string[]; }
const slash = (path: string) => path.split(sep).join("/");

function stat(file: string) {
    try { return lstatSync(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

/** All writes stay under the selected project, without following links or case aliases. */
function safePath(root: string, file: string): void {
    if (!inside(root, file)) throw new Error(`Generated path must stay inside the project: ${file}`);
    let current = root;
    for (const part of ["", ...relative(root, file).split(sep).filter(Boolean)]) {
        if (part) {
            if (stat(current)?.isDirectory()) {
                const conflict = readdirSync(current).find(name => name !== part && name.toLowerCase() === part.toLowerCase());
                if (conflict) throw new Error(`Path differs only by case from existing '${join(current, conflict)}'. Reuse the existing path.`);
            }
            current = join(current, part);
        }
        const entry = stat(current);
        if (entry?.isSymbolicLink()) throw new Error(`Generated paths must not contain symbolic links: ${current}`);
        if (entry && current !== file && !entry.isDirectory()) throw new Error(`Not a directory: ${current}`);
    }
}

function safeGeneratedTypes(root: string, api: string): void {
    safePath(root, join(root, ".boring", "tsconfig.json"));
    safePath(root, join(root, ".boring", "types", relative(root, api)));
}

/** Check every destination before writing; restore only our own files if validation fails. */
function writeChanges(root: string, changes: Change[], validate: () => void, restoreTypes?: () => void): string[] {
    for (const change of changes) {
        safePath(root, change.file);
        const existing = stat(change.file);
        if (change.before === undefined && existing) throw new Error(`Refusing to overwrite existing file: ${change.file}`);
        if (change.before !== undefined && (!existing?.isFile() || readFileSync(change.file, "utf8") !== change.before)) {
            throw new Error(`File changed while preparing generation: ${change.file}`);
        }
    }
    const createdDirectories: string[] = [];
    const written: Change[] = [];
    function directory(file: string) {
        if (stat(file)) return;
        directory(dirname(file));
        mkdirSync(file);
        createdDirectories.push(file);
    }
    try {
        for (const change of changes) {
            directory(dirname(change.file));
            safePath(root, change.file);
            if (change.before !== undefined && readFileSync(change.file, "utf8") !== change.before) throw new Error(`File changed while generating: ${change.file}`);
            writeFileSync(change.file, change.content, { flag: change.before === undefined ? "wx" : "w" });
            written.push(change);
        }
        validate();
    } catch (error) {
        for (const change of written.reverse()) {
            if (stat(change.file)?.isFile() && readFileSync(change.file, "utf8") === change.content) {
                if (change.before === undefined) unlinkSync(change.file);
                else writeFileSync(change.file, change.before);
            }
        }
        for (const file of createdDirectories.reverse()) {
            try { rmdirSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error; }
        }
        restoreTypes?.();
        throw error;
    }
    return changes.map(change => slash(relative(root, change.file)));
}

function apiPath(root: string, directory: string): string {
    const api = resolve(root, directory);
    if (api === root || !inside(root, api) || relative(root, api).split(sep).some(part => [".git", ".boring", "node_modules"].includes(part))) {
        throw new Error("The API directory must be a source directory inside the consumer project.");
    }
    safePath(root, api);
    safeGeneratedTypes(root, api);
    return api;
}

function checked(root: string, api: string, projectFile?: string, generated = false): AnalyzedProject {
    const project = analyzeProject(root, api, projectFile);
    if (project.diagnostics.length || project.architecture.length) throw new Error([
        generated ? "Generated code has check diagnostics against the application's current contracts." :
            "Fix existing check diagnostics before generating code.",
        ts.formatDiagnosticsWithColorAndContext(project.diagnostics, formatHost(root)),
        formatArchitectureDiagnostics(project.architecture, root),
    ].filter(Boolean).join("\n"));
    return project;
}

function object(value: unknown, field: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`package.json ${field} must be an object.`);
    return value as Record<string, unknown>;
}

/** Bootstrap a consumer without installing packages or running its code. */
export function initializeProject(directory: string, apiDirectory = "api"): ScaffoldResult {
    const root = resolve(directory);
    if (isAbsolute(apiDirectory) || apiDirectory.split("/").some(part => !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(part))) {
        throw new Error("Use a relative API directory such as api or src/api, without traversal or shell characters.");
    }
    const api = apiPath(root, apiDirectory);
    const apiName = slash(relative(root, api));
    if (["modules", "infra", "web"].includes(basename(api)) || inside(join(root, "dist"), api) || apiName === "test") {
        throw new Error("Choose an API directory separate from modules, infra, web, dist and the generated test directory.");
    }
    // An API tree may contain unrecognized files or a differently named route.
    // Initialization never adopts or modifies an existing application tree.
    for (const folder of [api, join(dirname(api), "modules"), join(dirname(api), "infra")]) {
        safePath(root, folder);
        if (stat(folder)) throw new Error(`Application directory already exists: ${folder}. Use boring inspect and boring add.`);
    }
    const manifestFile = join(root, "package.json");
    safePath(root, manifestFile);
    const before = stat(manifestFile) ? readFileSync(manifestFile, "utf8") : undefined;
    const manifest = before ? object(JSON.parse(before), "root") : {
        name: basename(root).toLowerCase().replace(/[^a-z0-9-]/g, "-") || "boring-app", version: "0.1.0", private: true,
    };
    if (manifest.type && manifest.type !== "commonjs") throw new Error("boring init requires a CommonJS package. Use a new project directory.");
    const scripts = object(manifest.scripts ?? {}, "scripts");
    for (const [name, command] of Object.entries(consumerScripts(apiName))) {
        if (scripts[name] !== undefined && scripts[name] !== command) throw new Error(`Refusing to replace package.json script '${name}'. Use a new project directory.`);
        scripts[name] = command;
    }
    // Workspace packages share a release version; no reverse dependency on CLI is needed.
    const own = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
    const core = require("@boringapi/core/package.json");
    const dependencies = object(manifest.dependencies ?? {}, "dependencies");
    const devDependencies = object(manifest.devDependencies ?? {}, "devDependencies");
    const moves: string[] = [];
    for (const [name, version, section] of [
        ["@boringapi/core", `^${core.version}`, "dependencies"],
        ["zod", core.peerDependencies.zod, "dependencies"],
        ["@boringapi/cli", `^${own.version}`, "devDependencies"],
    ] as const) {
        const target = section === "dependencies" ? dependencies : devDependencies;
        const other = section === "dependencies" ? devDependencies : dependencies;
        if (target[name] !== undefined && other[name] !== undefined && target[name] !== other[name]) {
            throw new Error(`Conflicting ${name} versions in dependencies and devDependencies. Keep the intended version in ${section} before running init.`);
        }
        target[name] ??= other[name] ?? version;
        if (other[name] !== undefined) moves.push(`Moved ${name} to ${section}; preserved its existing version.`);
        delete other[name];
    }
    const changes: Change[] = [{ file: manifestFile, before, content: JSON.stringify({ ...manifest, scripts, dependencies, devDependencies }, null, 2) + "\n" },
        ...Object.entries(consumerTemplates(apiName)).map(([file, content]) => ({ file: join(root, file), content }))];
    const files = writeChanges(root, changes, () => { generateTypes(root, api); });
    return { files, notes: [
        ...(before ? ["Merged missing package dependencies and scripts; preserved existing values."] : []),
        ...moves,
        "Next: install dependencies, then run sync, check, test and dev through the generated package scripts.",
        "The health endpoint is public. Configure real authentication and storage when the application needs them.",
    ] };
}

export function addModule(projectRoot: string, apiDirectory: string, name: string, projectFile?: string): ScaffoldResult {
    safePath(resolve(projectRoot), resolve(projectRoot));
    const root = realpathSync(projectRoot);
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) throw new Error("Use a lowercase module name such as orders or order-items.");
    const api = apiPath(root, apiDirectory);
    const project = checked(root, api, projectFile);
    const catalog = inspectProject(project);
    const target = join(dirname(api), "modules", name);
    safePath(root, target);
    if (stat(target)) {
        const existing = catalog.modules.find(module => module.name === name);
        const exports = existing?.facade?.exports.map(entry => entry.name).join(", ");
        throw new Error(`Module '${name}' already exists. Extend ${slash(relative(root, target))}/facade.ts and schemas.ts.${exports ? ` Public exports: ${exports}.` : ""}`);
    }
    const changes = Object.entries(moduleTemplate(name)).map(([file, content]) => ({ file: join(target, file), content }));
    const files = writeChanges(root, changes, () => { checked(root, api, projectFile, true); }, () => { analyzeProject(root, api, projectFile); });
    return { files, notes: [
        `Inspected existing modules: ${catalog.modules.map(module => module.name).join(", ") || "none"}.`,
        `Implement ${factoryName(name)} with the needed business operations and schemas, then wire it in ${slash(relative(root, api))}/+setup.ts.`,
        `Import the factory from $modules/${name}/facade and return the service from setup; inject infrastructure there.`,
    ] };
}

function endpointName(input: string) {
    const parts = input.replace(/^\//, "").split("/");
    const method = parts.pop()!;
    if (!HTTP_METHODS.has(method)) throw new Error("An endpoint ends in a lowercase HTTP method, for example orders/[id]/get (without .ts).");
    const segments = parts.map(endpointSegment);
    return { method, parts, path: `/${segments.join("/")}`, name: [...parts, method].join("/") };
}

const parameters = (path: string) => (path.match(/:[A-Za-z_][A-Za-z0-9_]*/g) ?? []).sort().join(",");
const scopeKey = (scope: SourceScope) => JSON.stringify([scope.middleware, scope.envelope,
    scope.errors.map(layer => [layer.generic, [...layer.statuses]])]);

function relocateAdapter(project: AnalyzedProject, route: RouteSource, target: string): string {
    const source = project.program.getSourceFile(route.file)!;
    const edits: { start: number; end: number; text: string }[] = [];
    function visit(node: ts.Node) {
        if (ts.isStringLiteralLike(node) && moduleLiteral(node) && node.text.startsWith(".") && node.text !== "./$types") {
            const imported = resolveImport(node.text, route.file, project.program.getCompilerOptions());
            if (!imported) throw new Error(`Cannot relocate import '${node.text}' from ${route.file}.`);
            const file = imported.resolvedFileName.replace(/(?:\.d)?\.[cm]?[jt]sx?$/, "");
            let specifier = slash(relative(dirname(target), file));
            if (!specifier.startsWith(".")) specifier = `./${specifier}`;
            edits.push({ start: node.getStart(source), end: node.end, text: JSON.stringify(specifier) });
        }
        ts.forEachChild(node, visit);
    }
    visit(source);
    let text = source.text;
    for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
    return text.endsWith("\n") ? text : `${text}\n`;
}

export function addEndpoint(projectRoot: string, apiDirectory: string, name: string, from?: string, projectFile?: string): ScaffoldResult {
    safePath(resolve(projectRoot), resolve(projectRoot));
    const root = realpathSync(projectRoot);
    const endpoint = endpointName(name);
    const sourceName = from === undefined ? undefined : endpointName(from).name;
    const api = apiPath(root, apiDirectory);
    const project = checked(root, api, projectFile);
    const catalog = inspectProject(project);
    const target = join(api, ...endpoint.parts, `${endpoint.method}.ts`);
    safePath(root, target);
    const routeKey = (method: string, path: string) => `${method} ${path.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ":param").toLowerCase()}`;
    if (project.sources.routes.some(route => routeKey(route.method, route.path) === routeKey(endpoint.method, endpoint.path))) {
        throw new Error(`Endpoint ${endpoint.method.toUpperCase()} ${endpoint.path} already exists or conflicts with an existing route. Extend it instead.`);
    }
    let parent = dirname(target);
    while (!project.sources.scopes.has(parent)) parent = dirname(parent);
    const scope = project.sources.scopes.get(parent)!;
    const routeName = (route: RouteSource) => slash(relative(api, route.file)).replace(/\.[jt]s$/, "");
    const compatible = (route: RouteSource) => route.file.endsWith(".ts") && route.method === endpoint.method &&
        parameters(route.path) === parameters(endpoint.path) && scopeKey(route.scope) === scopeKey(scope);
    let template: RouteSource | undefined;
    if (sourceName !== undefined) {
        template = project.sources.routes.find(route => routeName(route) === sourceName);
        if (!template) throw new Error(`No endpoint template '${sourceName}'. Run boring inspect to find an existing route.`);
        if (!compatible(template)) throw new Error("The template must be TypeScript and have the same HTTP method, URL parameter names and inherited hooks. Adapt a new handler explicitly when these differ.");
    } else {
        const group = endpoint.parts.find(part => !part.startsWith("["));
        const candidates = project.sources.routes.filter(route => compatible(route) && group !== undefined &&
            routeName(route).split("/").slice(0, -1).find(part => !part.startsWith("[")) === group);
        if (candidates.length > 1) throw new Error(`Multiple matching endpoint templates. Choose one with --from: ${candidates.map(routeName).join(", ")}.`);
        template = candidates[0];
    }
    const content = template ? relocateAdapter(project, template, target) : endpointTemplate(endpoint.method);
    const files = writeChanges(root, [{ file: target, content }], () => { checked(root, api, projectFile, true); }, () => { analyzeProject(root, api, projectFile); });
    return { files, notes: [
        `Inspected existing operations: ${catalog.services.flatMap(service => service.operations.map(operation => operation.access)).join(", ") || "none"}.`,
        template ? `Reused ${routeName(template)}: the same schemas, access declarations and service calls, with matching inherited hooks. Review the new URL's intended behavior.` :
            "No matching adapter. Created a typed 501 handler; implement it using existing public schemas and ctx.services before serving data.",
    ] };
}
