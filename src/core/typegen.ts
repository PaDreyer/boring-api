import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from "fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "path";

import { ApiSources, ContractSource, RouteSource, scanApi } from "./conventions";
import { inside, modulePaths } from "./compiler";

export interface TypegenResult {
    apiDirectory: string;
    generatedRoot: string;
    files: string[];
    sources: ApiSources;
}

function moduleSpecifier(fromFile: string, targetFile: string): string {
    const withoutExtension = targetFile.slice(0, -extname(targetFile).length);
    let specifier = relative(dirname(fromFile), withoutExtension).split(sep).join("/");
    if (!specifier.startsWith(".")) specifier = `./${specifier}`;
    return specifier;
}

function typeName(method: string): string {
    return `${method[0].toUpperCase()}${method.slice(1)}`;
}

function generatedFile(outputFile: string, directory: string, routes: RouteSource[], tree: ApiSources): string {
    const imports: string[] = [];
    const modules = new Map<string, string>();
    const moduleType = (file: string): string => {
        let name = modules.get(file);
        if (!name) {
            name = `Module${modules.size}`;
            modules.set(file, name);
            imports.push(`type ${name} = typeof import(${JSON.stringify(moduleSpecifier(outputFile, file))});`);
        }
        return name;
    };
    const locals = (middleware: string[]): string => middleware.reduce(
        (previous, file) => `Merge<${previous}, ObjectReturn<${moduleType(file)}["handler"]>>`, "{}",
    );
    const stages = (middleware: string[]): string[] => middleware.map((_, index) => locals(middleware.slice(0, index + 1)));
    const union = (types: string[], fallback: string): string => [...new Set(types)].join(" | ") || fallback;
    const routeContext = (route: RouteSource): string => `RouteContext<${moduleType(route.file)}, ${locals(route.scope.middleware)}>`;
    const own = tree.contracts.filter(contract => dirname(contract.file) === directory);
    const hooks = new Map(own.map(contract => [basename(contract.file, extname(contract.file)), contract.file]));
    const middleware = tree.contracts.filter(contract => /^\+middleware\.[jt]s$/.test(basename(contract.file)) && inside(dirname(contract.file), directory))
        .map(contract => contract.file).sort((a, b) => dirname(a).split(sep).length - dirname(b).split(sep).length);
    const setup = tree.setup ? moduleType(tree.setup) : undefined;
    const auth = tree.auth ? moduleType(tree.auth) : undefined;
    const definitions: string[] = [
        setup ? `export type Services = ObjectReturn<${setup}["setup"]>;` : "export type Services = {};",
        auth ? `type RawSession = ${auth} extends { authenticate: infer F } ? AwaitedReturn<F> : never;` : "type RawSession = never;",
        "export type Session = [NonNullable<RawSession>] extends [never] ? unknown : NonNullable<RawSession>;",
        auth ? `type AuthorizationRule = ${auth} extends { authorize: (context: any, rule: infer R, ...args: any[]) => any } ? R : never;` : "type AuthorizationRule = never;",
        `export type Locals = ${locals(middleware)};`,
        "",
    ];
    const exports: string[] = [];
    if (hooks.has("+setup")) exports.push(
        "export type SetupContext = BoringSetupContext;",
        "export type SetupHandler = (context: SetupContext) => MaybePromise<unknown>;",
    );
    if (hooks.has("+auth")) {
        const authorizationLocals = union(tree.routes.map(route =>
            `(${moduleType(route.file)} extends { authorization: unknown } ? ${locals(route.scope.middleware)} : never)`), "{}");
        exports.push(
            "export type AuthenticationContext = RequestContext<undefined, {}>;",
            "export type AuthenticationHandler = (context: AuthenticationContext) => MaybePromise<unknown>;",
            `type AuthorizationLocals = ${authorizationLocals};`,
            "export type AuthorizationContext = RequestContext<Session, [AuthorizationLocals] extends [never] ? {} : AuthorizationLocals>;",
            "export type AuthorizationHandler<Rule> = (context: AuthorizationContext, rule: Rule) => MaybePromise<void>;",
        );
    }
    const ownMiddleware = hooks.get("+middleware");
    if (ownMiddleware) exports.push(
        // A middleware must not depend on its own inferred return type.
        `export type MiddlewareContext = RequestContext<Session | undefined, ${locals(middleware.filter(file => file !== ownMiddleware))}>;`,
        "export type MiddlewareHandler = (context: MiddlewareContext) => MaybePromise<unknown>;",
    );
    const envelope = hooks.get("+envelope");
    if (envelope) {
        const contexts = tree.routes.filter(route => route.scope.envelope === envelope).map(route =>
            `(${moduleType(route.file)} extends { envelope: false } ? never : WithPayload<${routeContext(route)}, SchemaOutput<${moduleType(route.file)}, "output", HandlerOutput<${moduleType(route.file)}>>>)`);
        exports.push(
            `type EnvelopeRoutes = ${union(contexts, "never")};`,
            "export type EnvelopeContext = [EnvelopeRoutes] extends [never] ? RequestContext<Session | undefined, Locals> : EnvelopeRoutes;",
            "export type EnvelopeHandler = (context: EnvelopeContext) => MaybePromise<unknown>;",
        );
    }
    const errorHooks = [...hooks].filter(([name]) => /^\+error(?:\.[45]\d\d)?$/.test(name));
    if (errorHooks.length) {
        const contexts = tree.routes.filter(route => route.scope.errors.some(layer =>
            errorHooks.some(([, file]) => layer.generic === file || [...layer.statuses.values()].includes(file))));
        // Errors can occur before authentication or in any middleware. Preserve
        // earlier overwritten locals and make every local optional.
        exports.push(
            `export type ErrorContext = RequestContext<Session | undefined, PartialLocals<${union(contexts.flatMap(route => stages(route.scope.middleware)), "{}")}>>;`,
            "export type ErrorHandler = (context: ErrorContext, error: Error) => MaybePromise<unknown>;",
        );
    }
    for (const route of routes.sort((left, right) => left.method.localeCompare(right.method))) {
        const prefix = typeName(route.method);
        const routeModule = moduleType(route.file);
        exports.push(
            `export type ${prefix}Context = ${routeContext(route)};`,
            `export type ${prefix}Output = SchemaOutput<${routeModule}, "output", unknown>;`,
            `export type ${prefix}Handler = AuthorizationIsValid<${routeModule}> extends true ? (context: ${prefix}Context) => MaybePromise<SchemaInput<${routeModule}, "output", unknown>> : never;`,
        );
    }
    return [
        "// Generated by Boring API. Do not edit.",
        'import type { Context as BoringContext, SetupContext as BoringSetupContext } from "@boringapi/core";',
        'import type { z } from "zod";',
        "",
        "type AwaitedReturn<F> = F extends (...args: any[]) => infer R ? Awaited<R> : never;",
        "type ObjectPart<T> = T extends Record<string, unknown> ? T : {};",
        "type ObjectReturn<F> = [AwaitedReturn<F>] extends [never] ? {} : ObjectPart<AwaitedReturn<F>>;",
        "type SchemaOutput<M, K extends PropertyKey, F> = M extends Record<K, infer S> ? S extends z.ZodTypeAny ? z.output<S> : F : F;",
        "type SchemaInput<M, K extends PropertyKey, F> = M extends Record<K, infer S> ? S extends z.ZodTypeAny ? z.input<S> : F : F;",
        "type Simplify<T> = { [K in keyof T]: T[K] } & {};",
        "type Merge<A, B> = A extends unknown ? B extends unknown ? Simplify<Omit<A, keyof B> & B> : never : never;",
        "type MaybePromise<T> = T | Promise<T>;",
        "type UnionKeys<T> = T extends unknown ? keyof T : never;",
        "type PartialLocals<T> = { [K in UnionKeys<T>]?: T extends unknown ? K extends keyof T ? T[K] : never : never };",
        "type HandlerOutput<M> = M extends { handler: infer F } ? undefined extends AwaitedReturn<F> ? unknown : AwaitedReturn<F> : unknown;",
        'type WithPayload<C, P> = C extends unknown ? Omit<C, "payload"> & { get payload(): P; set payload(value: unknown); } : never;',
        "",
        ...imports, "", ...definitions,
        'type RequestContext<S, L> = Omit<BoringContext, "session" | "services" | "locals"> & {',
        "    readonly session: S;",
        "    readonly services: Readonly<Services>;",
        "    readonly locals: L;",
        "};",
        'type RouteContext<M, L> = Omit<RequestContext<M extends { authentication: true } | { authorization: unknown } ? Session : Session | undefined, L>, "params" | "query" | "body"> & {',
        '    readonly params: SchemaOutput<M, "params", BoringContext["params"]>;',
        '    readonly query: SchemaOutput<M, "query", BoringContext["query"]>;',
        '    readonly body: SchemaOutput<M, "body", BoringContext["body"]>;',
        "};",
        "type AuthorizationIsValid<M> = M extends { authorization: infer R } ? R extends AuthorizationRule ? true : false : true;",
        "", ...exports, "",
    ].join("\n");
}

function generatedContracts(outputFile: string, contracts: ContractSource[], auth: string | undefined): string {
    const lines = [
        "// Generated by Boring API. Do not edit.",
        'import type { z } from "zod";',
        "",
        auth
            ? `type AuthModule = typeof import(${JSON.stringify(moduleSpecifier(outputFile, auth))});`
            : "type AuthModule = {};",
        'type AuthorizationRule = AuthModule extends { authorize: (context: any, rule: infer R, ...args: any[]) => any } ? R : never;',
        "type AnyFunction = (...args: any[]) => any;",
        "type RouteContract = {",
        "    handler: AnyFunction;",
        "    params?: z.ZodTypeAny;",
        "    query?: z.ZodTypeAny;",
        "    body?: z.ZodTypeAny;",
        "    output?: z.ZodTypeAny;",
        "    authentication?: boolean;",
        "    authorization?: AuthorizationRule;",
        "    envelope?: boolean;",
        "};",
        "type SetupContract = { setup: AnyFunction };",
        "type AuthContract =",
        "    | { authenticate: AnyFunction; authorize?: AnyFunction }",
        "    | { authenticate?: AnyFunction; authorize: AnyFunction };",
        "type HookContract = { handler: AnyFunction };",
        "type AssertRoute<T extends RouteContract> = T;",
        "type AssertSetup<T extends SetupContract> = T;",
        "type AssertAuth<T extends AuthContract> = T;",
        "type AssertHook<T extends HookContract> = T;",
        "",
    ];
    contracts.forEach((contract, index) => {
        const assertion = contract.kind[0].toUpperCase() + contract.kind.slice(1);
        lines.push(`type Contract${index} = Assert${assertion}<typeof import(${JSON.stringify(moduleSpecifier(outputFile, contract.file))})>;`);
    });
    return `${lines.join("\n")}\n`;
}

function childPath(parent: string, child: string, description: string): string {
    const path = relative(parent, child);
    if (path === "") return path;
    if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
        throw new Error(`${description} must be inside the project root: ${child}`);
    }
    return path;
}

function rejectSymbolicLinkPath(parent: string, child: string): void {
    const path = childPath(parent, child, "Generated types directory");
    let current = parent;
    for (const part of path.split(sep).filter(Boolean)) {
        current = join(current, part);
        try {
            if (lstatSync(current).isSymbolicLink()) {
                throw new Error(`Generated types path must not contain symbolic links: ${current}`);
            }
        } catch (error) {
            if (error && typeof error === "object" && "code" in error &&
                (error as { code?: unknown }).code === "ENOENT") return;
            throw error;
        }
    }
}

/** Generates virtual $types modules for every route and hook folder. */
export function generateTypes(projectRoot: string, apiDirectory: string): TypegenResult {
    const root = realpathSync(resolve(projectRoot));
    const requestedApi = resolve(root, apiDirectory);
    if (!existsSync(requestedApi)) throw new Error(`API directory does not exist: ${requestedApi}`);
    if (!statSync(requestedApi).isDirectory()) throw new Error(`API directory is not a directory: ${requestedApi}`);
    const api = realpathSync(requestedApi);
    const apiPath = childPath(root, api, "API directory");
    const generatedRoot = join(root, ".boring", "types");
    const generatedApiRoot = join(generatedRoot, apiPath);
    childPath(generatedRoot, generatedApiRoot, "Generated types directory");
    const tree = scanApi(api);

    rejectSymbolicLinkPath(root, generatedApiRoot);
    rmSync(generatedApiRoot, { recursive: true, force: true });
    const files: string[] = [];
    const routesByDirectory = new Map<string, RouteSource[]>();
    for (const route of tree.routes) {
        const current = routesByDirectory.get(route.directory) ?? [];
        current.push(route);
        routesByDirectory.set(route.directory, current);
    }

    for (const contract of tree.contracts) {
        const directory = dirname(contract.file);
        if (!routesByDirectory.has(directory)) routesByDirectory.set(directory, []);
    }

    for (const [directory, routes] of routesByDirectory) {
        const output = join(generatedApiRoot, relative(api, directory), "$types.d.ts");
        mkdirSync(dirname(output), { recursive: true });
        writeFileSync(output, generatedFile(output, directory, routes, tree));
        files.push(output);
    }

    if (tree.contracts.length) {
        // A .ts file is intentional: consumers commonly enable skipLibCheck, which would
        // suppress contract failures inside a generated declaration file.
        const contractsFile = join(generatedApiRoot, "$contracts.ts");
        mkdirSync(dirname(contractsFile), { recursive: true });
        writeFileSync(contractsFile, generatedContracts(contractsFile, tree.contracts, tree.auth));
        files.push(contractsFile);
    }

    mkdirSync(join(root, ".boring"), { recursive: true });
    rejectSymbolicLinkPath(root, join(root, ".boring", "tsconfig.json"));
    writeFileSync(join(root, ".boring", "tsconfig.json"), `${JSON.stringify({
        // TS 4.9 resolves paths without baseUrl, but its import-path completions
        // still require it. Keep generated targets relative to the project root.
        compilerOptions: { baseUrl: "..", rootDirs: ["..", "./types"], paths: modulePaths(api, root) },
    }, null, 2)}\n`);

    return { apiDirectory: api, generatedRoot, files, sources: tree };
}
