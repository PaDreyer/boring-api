import { Dirent, existsSync, readdirSync, statSync } from "fs";
import { dirname, extname, join, resolve } from "path";
export { APPLICATION_ROLES, applicationRole, applicationDirectories, allowsModuleDependency, canonicalPath, withinDirectory } from "./roles";
export type { ApplicationRole, RoleSource } from "./roles";

export const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

export interface TemplateLayer<T> {
    generic?: T;
    statuses: Map<number, T>;
}

export interface SourceScope {
    middleware: string[];
    envelope?: string;
    errors: TemplateLayer<string>[];
}

export interface RouteSource {
    method: string;
    path: string;
    file: string;
    directory: string;
    scope: SourceScope;
}

export interface ContractSource {
    file: string;
    kind: "route" | "config" | "setup" | "auth" | "hook";
}

export interface ApiSources {
    routes: RouteSource[];
    jobs: JobSource[];
    contracts: ContractSource[];
    config?: string;
    setup?: string;
    auth?: string;
    rootScope: SourceScope;
    scopes: Map<string, SourceScope>;
}

export interface JobSource { name: string; file: string; }

/** One named entry per folder. No executable helper files or side registries. */
export function scanJobs(apiDirectory: string): JobSource[] {
    const root = join(dirname(resolve(apiDirectory)), "jobs");
    if (!existsSync(root)) return [];
    const jobs: JobSource[] = [];
    function walk(directory: string, parts: string[]) {
        let found = false;
        for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const file = join(directory, entry.name);
            if (entry.isSymbolicLink()) throw new Error(`Job source must not contain symbolic links: ${file}`);
            if (entry.isDirectory()) {
                if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(entry.name)) throw new Error(`Invalid job directory: ${file}`);
                walk(file, [...parts, entry.name]);
            } else if (/\.[cm]?[jt]sx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
                if (!parts.length || !/^job\.[jt]s$/.test(entry.name) || found) throw new Error(`Expected one jobs/<name>/job.ts or job.js declaration: ${file}`);
                found = true;
                jobs.push({ name: parts.join("/"), file });
            }
        }
    }
    walk(root, []);
    return jobs.sort((a, b) => a.name.localeCompare(b.name));
}

/** Shared by runtime error handling and static inspection. Layers are root to leaf. */
export function findErrorTemplate<T>(layers: TemplateLayer<T>[], status: number): T | undefined {
    for (let index = layers.length - 1; index >= 0; index--) {
        const layer = layers[index];
        const template = layer.statuses.get(status) ??
            (status >= 500 ? layer.statuses.get(500) : undefined) ?? layer.generic;
        if (template !== undefined) return template;
    }
    return undefined;
}

function sourceName(entry: Dirent): string | undefined {
    if (!entry.isFile() || entry.name.endsWith(".d.ts")) return undefined;
    const extension = extname(entry.name);
    return extension === ".ts" || extension === ".js" ? entry.name.slice(0, -extension.length) : undefined;
}

export function endpointSegment(name: string): string {
    const dynamic = /^\[([A-Za-z_][A-Za-z0-9_]*)\]$/.exec(name);
    if (dynamic) return `:${dynamic[1]}`;
    if (/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) return name;
    throw new Error(`Invalid endpoint directory '${name}'. Use a URL segment or [param].`);
}

function routeOrder(a: RouteSource, b: RouteSource): number {
    const left = a.path.split("/").filter(Boolean);
    const right = b.path.split("/").filter(Boolean);
    for (let i = 0; i < Math.min(left.length, right.length); i++) {
        const aDynamic = left[i].startsWith(":");
        const bDynamic = right[i].startsWith(":");
        if (aDynamic !== bDynamic) return aDynamic ? 1 : -1;
        if (left[i] !== right[i]) return left[i].localeCompare(right[i]);
    }
    if (left.length !== right.length) return left.length - right.length;
    if (a.method === "head" && b.method === "get") return -1;
    if (a.method === "get" && b.method === "head") return 1;
    return a.method.localeCompare(b.method);
}

/** The common structural model; does not import or execute any application module. */
export function scanApi(apiDirectory: string): ApiSources {
    const root = resolve(apiDirectory);
    try {
        if (!statSync(root).isDirectory()) throw new Error(`API directory is not a directory: ${root}`);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`API directory does not exist: ${root}`);
        throw error;
    }
    const tree: ApiSources = { routes: [], jobs: scanJobs(root), contracts: [], rootScope: { middleware: [], errors: [] }, scopes: new Map() };
    const seenRoutes = new Map<string, string>();
    function walk(directory: string, inherited: SourceScope, segments: string[]) {
        const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
        const files = new Map<string, string>();
        const errors: TemplateLayer<string> = { statuses: new Map() };
        for (const entry of entries) {
            const name = sourceName(entry);
            if (!name) continue;
            const file = join(directory, entry.name);
            if (files.has(name)) throw new Error(`Duplicate source files: ${files.get(name)} and ${file}`);
            files.set(name, file);
            if (!name.startsWith("+")) {
                if (!HTTP_METHODS.has(name)) throw new Error(`Unsupported endpoint file: ${file}`);
                tree.contracts.push({ file, kind: "route" });
            } else if (name === "+setup" || name === "+auth" || name === "+config") {
                if (segments.length) throw new Error(`${file}: ${name} is only allowed at the API root`);
                const kind = name === "+setup" ? "setup" : name === "+config" ? "config" : "auth";
                tree[kind] = file;
                tree.contracts.push({ file, kind });
            } else {
                if (name === "+error") errors.generic = file;
                else if (/^\+error\.[4-5]\d\d$/.test(name)) errors.statuses.set(Number(name.slice(7)), file);
                else if (name !== "+middleware" && name !== "+envelope") throw new Error(`Unknown convention file: ${file}`);
                tree.contracts.push({ file, kind: "hook" });
            }
        }
        const middleware = files.get("+middleware");
        const scope: SourceScope = {
            middleware: middleware ? [...inherited.middleware, middleware] : inherited.middleware,
            envelope: files.get("+envelope") ?? inherited.envelope,
            errors: errors.generic || errors.statuses.size ? [...inherited.errors, errors] : inherited.errors,
        };
        if (!segments.length) tree.rootScope = scope;
        tree.scopes.set(directory, scope);
        for (const entry of entries) {
            const file = join(directory, entry.name);
            if (entry.isDirectory()) {
                walk(file, scope, [...segments, endpointSegment(entry.name)]);
                continue;
            }
            const name = sourceName(entry);
            if (!name || !HTTP_METHODS.has(name)) continue;
            const path = segments.length ? `/${segments.join("/")}` : "/";
            const key = `${name} ${path.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ":param").toLowerCase()}`;
            if (seenRoutes.has(key)) throw new Error(`Duplicate route ${key}: ${seenRoutes.get(key)} and ${file}`);
            seenRoutes.set(key, file);
            tree.routes.push({ method: name, path, file, directory, scope });
        }
    }
    walk(root, tree.rootScope, []);
    tree.routes.sort(routeOrder);
    return tree;
}
