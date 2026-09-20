import { realpathSync } from "fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "path";

/** Compiler-free application roles. Source tools share these names and locations. */
export const APPLICATION_ROLES = {
    endpoint: "HTTP transport; calls injected public operations",
    hook: "Request pipeline; calls public operations",
    config: "Application configuration; loads and validates data before setup",
    execution: "Controlled non-HTTP entry; calls injected public operations",
    setup: "Application composition; constructs dependencies and owns resource cleanup",
    facade: "Public use cases; coordinates access, services and transactions",
    service: "Module business rules; calls injected ports",
    schemas: "Shared data and validation contracts",
    port: "Type-only effect and storage contracts",
    adapter: "Infrastructure implementation and resource construction",
    page: "Server presentation; calls injected public operations",
    browser: "Browser presentation and HTTP client",
    unknown: "Unclassified application source",
} as const;

export type ApplicationRole = keyof typeof APPLICATION_ROLES;
export interface RoleSource { role: ApplicationRole; module?: string; public?: boolean; }

export function canonicalPath(file: string): string {
    try { return realpathSync(file); } catch { return resolve(file); }
}

export function withinDirectory(parent: string, file: string): boolean {
    const path = relative(parent, file);
    return path === "" || path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

export function applicationDirectories(apiDirectory: string) {
    const api = canonicalPath(apiDirectory);
    const parent = dirname(api);
    return { api, executions: canonicalPath(join(parent, "executions")), modules: canonicalPath(join(parent, "modules")), infra: canonicalPath(join(parent, "infra")),
        browser: canonicalPath(join(parent, "web/client")), pages: canonicalPath(join(parent, "web/server")) };
}

export function applicationRole(apiDirectory: string, file: string): RoleSource {
    const roots = applicationDirectories(apiDirectory);
    const target = canonicalPath(file);
    if (withinDirectory(roots.api, target)) {
        const name = basename(target).replace(/\.[jt]s$/, "");
        return { role: dirname(target) === roots.api && name === "+config" ? "config" : dirname(target) === roots.api && name === "+setup" ? "setup" :
            /^(get|post|put|patch|delete|head|options)$/.test(name) ? "endpoint" : name.startsWith("+") ? "hook" : "unknown" };
    }
    if (withinDirectory(roots.modules, target)) {
        const [module, ...parts] = relative(roots.modules, target).split(sep);
        const entry = parts.length === 1 ? parts[0].replace(/\.(?:d\.)?[cm]?[jt]sx?$/, "") : undefined;
        const role = entry === "facade" || parts[0] === "facade" ? "facade" :
            entry === "service" || parts[0] === "services" ? "service" :
            entry === "schemas" || parts[0] === "schemas" ? "schemas" :
            parts[0] === "ports" ? "port" : "unknown";
        return { role, module: parts.length ? module : undefined, public: entry === "facade" || entry === "schemas" };
    }
    if (withinDirectory(roots.executions, target)) return { role: "execution" };
    if (withinDirectory(roots.infra, target)) return { role: "adapter" };
    if (withinDirectory(roots.browser, target)) return { role: "browser" };
    if (withinDirectory(roots.pages, target)) return { role: "page" };
    return { role: "unknown" };
}

/** Module dependency matrix, including erased edges. Ports have no runtime exports. */
export function allowsModuleDependency(from: RoleSource, to: RoleSource, typeOnly: boolean): boolean {
    const own = !!from.module && from.module === to.module;
    if (to.role === "schemas") return !!to.public || own && ["schemas", "facade", "service", "port"].includes(from.role);
    if (to.role === "port") return typeOnly && (own && ["facade", "service", "port"].includes(from.role) ||
        ["setup", "adapter"].includes(from.role));
    if (to.role === "service") return own && from.role === "facade";
    if (to.role === "facade") return (own && from.role === "facade") || !!to.public &&
        (["setup", "hook", "facade", "page"].includes(from.role));
    return false;
}
