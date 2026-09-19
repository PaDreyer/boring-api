import { Dirent, readdirSync, statSync } from "fs";
import { basename, join, resolve } from "path";
import {
    AuthModule, EnvelopeModule, ErrorLayer, ErrorModule, MiddlewareModule,
    Route, RouteModule, RouteScope, SetupModule,
} from "./types";

const METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

export interface Discovery {
    routes: Route[];
    setup?: SetupModule;
    auth?: AuthModule;
    rootScope: RouteScope;
}

function codeName(entry: Dirent): string | undefined {
    if (!entry.isFile() || entry.name.endsWith(".d.ts")) return undefined;
    if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".js")) return undefined;
    return basename(entry.name, entry.name.endsWith(".ts") ? ".ts" : ".js");
}

function load(file: string): Record<string, unknown> {
    const module = require(file);
    if (!module || typeof module !== "object") {
        throw new Error(`${file} must use named exports`);
    }
    return module as Record<string, unknown>;
}

function withHandler<T>(file: string): T {
    const module = load(file);
    if (typeof module.handler !== "function") throw new Error(`${file} must export handler()`);
    return module as unknown as T;
}

function routeModule(file: string): RouteModule {
    const module = withHandler<RouteModule>(file);
    for (const field of ["params", "query", "body", "output"] as const) {
        const schema = module[field];
        if (schema !== undefined && (!schema || typeof schema.parse !== "function")) {
            throw new Error(`${file}: ${field} must be a Zod schema`);
        }
    }
    for (const field of ["authentication", "envelope"] as const) {
        if (module[field] !== undefined && typeof module[field] !== "boolean") {
            throw new Error(`${file}: ${field} must be a boolean`);
        }
    }
    return module;
}

function segment(name: string): string {
    const dynamic = /^\[([A-Za-z_][A-Za-z0-9_]*)\]$/.exec(name);
    if (dynamic) return `:${dynamic[1]}`;
    if (/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) return name;
    throw new Error(`Invalid endpoint directory '${name}'. Use a URL segment or [param].`);
}

function orderedEntries(dir: string): Dirent[] {
    return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
}

function routeOrder(a: Route, b: Route): number {
    const left = a.path.split("/").filter(Boolean);
    const right = b.path.split("/").filter(Boolean);
    for (let i = 0; i < Math.min(left.length, right.length); i++) {
        const aDynamic = left[i].startsWith(":");
        const bDynamic = right[i].startsWith(":");
        if (aDynamic !== bDynamic) return aDynamic ? 1 : -1;
        if (left[i] !== right[i]) return left[i].localeCompare(right[i]);
    }
    if (left.length !== right.length) return left.length - right.length;
    // Express answers HEAD with a GET route; register explicit HEAD first.
    if (a.method === "head" && b.method === "get") return -1;
    if (a.method === "get" && b.method === "head") return 1;
    return a.method.localeCompare(b.method);
}

export function discover(apiDirectory: string): Discovery {
    const root = resolve(apiDirectory);
    try {
        if (!statSync(root).isDirectory()) throw new Error(`API directory is not a directory: ${root}`);
    } catch (error) {
        if (error && typeof error === "object" && "code" in error &&
            (error as { code?: unknown }).code === "ENOENT") {
            throw new Error(`API directory does not exist: ${root}`);
        }
        throw error;
    }

    const routes: Route[] = [];
    const seenRoutes = new Map<string, string>();
    let setup: SetupModule | undefined;
    let auth: AuthModule | undefined;
    let rootScope: RouteScope | undefined;

    function walk(dir: string, segments: string[], inherited: RouteScope): void {
        const entries = orderedEntries(dir);
        const localErrors: ErrorLayer = { statuses: new Map() };
        let middleware: MiddlewareModule | undefined;
        let envelope: EnvelopeModule | undefined;
        let hasErrorFile = false;

        // Read configuration files before registering routes, regardless of directory order.
        for (const entry of entries) {
            const name = codeName(entry);
            if (!name?.startsWith("+")) continue;
            const file = join(dir, entry.name);
            switch (name) {
                case "+setup": {
                    if (segments.length) throw new Error(`${file}: +setup is only allowed at the API root`);
                    if (setup) throw new Error(`Duplicate +setup file: ${file}`);
                    const module = load(file);
                    if (typeof module.setup !== "function") throw new Error(`${file} must export setup()`);
                    setup = module as unknown as SetupModule;
                    break;
                }
                case "+auth": {
                    if (segments.length) throw new Error(`${file}: +auth is only allowed at the API root`);
                    if (auth) throw new Error(`Duplicate +auth file: ${file}`);
                    const module = load(file);
                    if (module.authenticate !== undefined && typeof module.authenticate !== "function") {
                        throw new Error(`${file}: authenticate must be a function`);
                    }
                    if (module.authorize !== undefined && typeof module.authorize !== "function") {
                        throw new Error(`${file}: authorize must be a function`);
                    }
                    if (!module.authenticate && !module.authorize) {
                        throw new Error(`${file} must export authenticate() or authorize()`);
                    }
                    auth = module as unknown as AuthModule;
                    break;
                }
                case "+middleware":
                    if (middleware) throw new Error(`Duplicate +middleware file: ${file}`);
                    middleware = withHandler<MiddlewareModule>(file);
                    break;
                case "+envelope":
                    if (envelope) throw new Error(`Duplicate +envelope file: ${file}`);
                    envelope = withHandler<EnvelopeModule>(file);
                    break;
                case "+error":
                    if (localErrors.generic) throw new Error(`Duplicate +error file: ${file}`);
                    localErrors.generic = withHandler<ErrorModule>(file);
                    hasErrorFile = true;
                    break;
                default: {
                    const statusMatch = /^\+error\.([4-5]\d\d)$/.exec(name);
                    if (!statusMatch) throw new Error(`Unknown convention file: ${file}`);
                    const status = Number(statusMatch[1]);
                    if (localErrors.statuses.has(status)) throw new Error(`Duplicate +error.${status} file: ${file}`);
                    localErrors.statuses.set(status, withHandler<ErrorModule>(file));
                    hasErrorFile = true;
                }
            }
        }

        const scope: RouteScope = {
            middleware: middleware ? [...inherited.middleware, middleware] : inherited.middleware,
            envelope: envelope ?? inherited.envelope,
            errors: hasErrorFile ? [...inherited.errors, localErrors] : inherited.errors,
        };
        if (!segments.length) rootScope = scope;

        for (const entry of entries) {
            const file = join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === "_base" || entry.name === "_setup") {
                    throw new Error(`${file}: use +auth, +setup, +middleware, +envelope and +error files instead`);
                }
                walk(file, [...segments, segment(entry.name)], scope);
                continue;
            }
            const name = codeName(entry);
            if (!name || name.startsWith("+")) continue;
            if (!METHODS.has(name)) throw new Error(`Unsupported endpoint file: ${file}`);
            const path = segments.length ? `/${segments.join("/")}` : "/";
            const key = `${name} ${path.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ":param").toLowerCase()}`;
            if (seenRoutes.has(key)) throw new Error(`Duplicate route ${key}: ${seenRoutes.get(key)} and ${file}`);
            seenRoutes.set(key, file);
            routes.push({ method: name, path, source: file, module: routeModule(file), scope });
        }
    }

    walk(root, [], { middleware: [], errors: [] });
    routes.sort(routeOrder);
    return { routes, setup, auth, rootScope: rootScope! };
}
