import { AuthModule, ConfigModule, Route, RouteScope, SetupModule } from "./types";
import { scanApi, SourceScope } from "./conventions";
import type { RouteModule } from "./types";

export interface Discovery {
    routes: Route[];
    config?: ConfigModule;
    setup?: SetupModule;
    auth?: AuthModule;
    rootScope: RouteScope;
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

export function discover(apiDirectory: string): Discovery {
    const sources = scanApi(apiDirectory);
    let config: ConfigModule | undefined;
    let setup: SetupModule | undefined;
    let auth: AuthModule | undefined;
    type Hook = { handler: (...args: any[]) => unknown };
    const hooks = new Map<string, Hook>();
    const routes = new Map<string, RouteModule>();
    for (const contract of sources.contracts) {
        const file = contract.file;
        if (contract.kind === "route") routes.set(file, routeModule(file));
        else if (contract.kind === "hook") hooks.set(file, withHandler<Hook>(file));
        else if (contract.kind === "config") {
            const module = load(file);
            if (typeof module.load !== "function" || !module.schema || typeof (module.schema as any).parseAsync !== "function") throw new Error(`${file} must export load(env) and a Zod schema`);
            config = module as unknown as ConfigModule;
        } else if (contract.kind === "setup") {
            const module = load(file);
            if (typeof module.setup !== "function") throw new Error(`${file} must export setup()`);
            setup = module as unknown as SetupModule;
        } else {
            const module = load(file);
            if (module.authenticate !== undefined && typeof module.authenticate !== "function") {
                throw new Error(`${file}: authenticate must be a function`);
            }
            if (module.authorize !== undefined && typeof module.authorize !== "function") {
                throw new Error(`${file}: authorize must be a function`);
            }
            if (!module.authenticate && !module.authorize) throw new Error(`${file} must export authenticate() or authorize()`);
            auth = module as unknown as AuthModule;
        }
    }
    const scope = (source: SourceScope): RouteScope => ({
        middleware: source.middleware.map(file => hooks.get(file)!),
        envelope: source.envelope ? hooks.get(source.envelope) : undefined,
        errors: source.errors.map(layer => ({
            generic: layer.generic ? hooks.get(layer.generic) : undefined,
            statuses: new Map([...layer.statuses].map(([status, file]) => [status, hooks.get(file)!])),
        })),
    });
    return {
        config, setup, auth, rootScope: scope(sources.rootScope),
        routes: sources.routes.map(route => ({ method: route.method, path: route.path,
            source: route.file, module: routes.get(route.file)!, scope: scope(route.scope) })),
    };
}
