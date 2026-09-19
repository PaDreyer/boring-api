import { Dirent, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "path";

const METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

interface RouteSource {
    method: string;
    file: string;
    directory: string;
    middleware: string[];
}

type ContractKind = "route" | "setup" | "auth" | "hook";

interface ContractSource {
    file: string;
    kind: ContractKind;
}

interface TypegenTree {
    routes: RouteSource[];
    contracts: ContractSource[];
    setup?: string;
    auth?: string;
}

export interface TypegenResult {
    apiDirectory: string;
    generatedRoot: string;
    files: string[];
}

function sourceName(entry: Dirent): string | undefined {
    if (!entry.isFile() || entry.name.endsWith(".d.ts")) return undefined;
    const extension = extname(entry.name);
    if (extension !== ".ts" && extension !== ".js") return undefined;
    return entry.name.slice(0, -extension.length);
}

function scan(apiDirectory: string): TypegenTree {
    const tree: TypegenTree = { routes: [], contracts: [] };
    const seenRoutes = new Map<string, string>();

    function walk(directory: string, inheritedMiddleware: string[], segments: string[]): void {
        const entries = readdirSync(directory, { withFileTypes: true })
            .sort((left, right) => left.name.localeCompare(right.name));
        let middleware: string | undefined;
        const sourceFiles = new Map<string, string>();

        for (const entry of entries) {
            const name = sourceName(entry);
            if (!name) continue;
            const file = join(directory, entry.name);
            const duplicate = sourceFiles.get(name);
            if (duplicate) throw new Error(`Duplicate source files: ${duplicate} and ${file}`);
            sourceFiles.set(name, file);

            if (!name.startsWith("+")) {
                if (!METHODS.has(name)) throw new Error(`Unsupported endpoint file: ${file}`);
                continue;
            }

            switch (name) {
                case "+setup":
                    if (segments.length) throw new Error(`${file}: +setup is only allowed at the API root`);
                    tree.setup = file;
                    tree.contracts.push({ file, kind: "setup" });
                    break;
                case "+auth":
                    if (segments.length) throw new Error(`${file}: +auth is only allowed at the API root`);
                    tree.auth = file;
                    tree.contracts.push({ file, kind: "auth" });
                    break;
                case "+middleware":
                    middleware = file;
                    tree.contracts.push({ file, kind: "hook" });
                    break;
                case "+envelope":
                case "+error":
                    tree.contracts.push({ file, kind: "hook" });
                    break;
                default:
                    if (!/^\+error\.[4-5]\d\d$/.test(name)) {
                        throw new Error(`Unknown convention file: ${file}`);
                    }
                    tree.contracts.push({ file, kind: "hook" });
            }
        }

        const middlewareChain = middleware ? [...inheritedMiddleware, middleware] : inheritedMiddleware;
        for (const entry of entries) {
            const file = join(directory, entry.name);
            if (entry.isDirectory()) {
                walk(file, middlewareChain, [...segments, endpointSegment(entry.name)]);
                continue;
            }
            const name = sourceName(entry);
            if (name && METHODS.has(name)) {
                const path = segments.length ? `/${segments.join("/")}` : "/";
                const normalizedPath = path
                    .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ":param")
                    .toLowerCase();
                const key = `${name} ${normalizedPath}`;
                const duplicate = seenRoutes.get(key);
                if (duplicate) throw new Error(`Duplicate route ${key}: ${duplicate} and ${file}`);
                seenRoutes.set(key, file);
                tree.routes.push({ method: name, file, directory, middleware: middlewareChain });
                tree.contracts.push({ file, kind: "route" });
            }
        }
    }

    walk(apiDirectory, [], []);
    return tree;
}

function endpointSegment(name: string): string {
    const dynamic = /^\[([A-Za-z_][A-Za-z0-9_]*)\]$/.exec(name);
    if (dynamic) return `:${dynamic[1]}`;
    if (/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) return name;
    throw new Error(`Invalid endpoint directory '${name}'. Use a URL segment or [param].`);
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

function generatedFile(
    outputFile: string,
    routes: RouteSource[],
    setup: string | undefined,
    auth: string | undefined,
): string {
    const lines: string[] = [
        "// Generated by Boring API. Do not edit.",
        'import type { Context as BoringContext } from "@boringapi/core";',
        'import type { z } from "zod";',
        "",
        "type AwaitedReturn<F> = F extends (...args: any[]) => infer R ? Awaited<R> : never;",
        "type ObjectPart<T> = Extract<T, Record<string, unknown>>;",
        "type ObjectReturn<F> = [ObjectPart<AwaitedReturn<F>>] extends [never] ? {} : ObjectPart<AwaitedReturn<F>>;",
        "type SchemaOutput<M, K extends PropertyKey, F> = M extends Record<K, infer S> ? S extends z.ZodTypeAny ? z.output<S> : F : F;",
        "type SchemaInput<M, K extends PropertyKey, F> = M extends Record<K, infer S> ? S extends z.ZodTypeAny ? z.input<S> : F : F;",
        "type Simplify<T> = { [K in keyof T]: T[K] } & {};",
        "type Merge<A, B> = A extends unknown ? B extends unknown ? Simplify<Omit<A, keyof B> & B> : never : never;",
        "type MaybePromise<T> = T | Promise<T>;",
        "",
    ];

    if (setup) {
        lines.push(`type SetupModule = typeof import(${JSON.stringify(moduleSpecifier(outputFile, setup))});`);
        lines.push('type Services = ObjectReturn<SetupModule["setup"]>;');
    } else {
        lines.push("type Services = {};");
    }
    if (auth) {
        lines.push(`type AuthModule = typeof import(${JSON.stringify(moduleSpecifier(outputFile, auth))});`);
        lines.push('type RawSession = AuthModule extends { authenticate: infer F } ? AwaitedReturn<F> : never;');
        lines.push("type Session = [NonNullable<RawSession>] extends [never] ? unknown : NonNullable<RawSession>;");
        lines.push('type AuthorizationRule = AuthModule extends { authorize: (context: any, rule: infer R, ...args: any[]) => any } ? R : never;');
    } else {
        lines.push("type Session = unknown;");
        lines.push("type AuthorizationRule = never;");
    }
    lines.push("");

    const middleware = routes[0]?.middleware ?? [];
    middleware.forEach((file, index) => {
        lines.push(`type Middleware${index} = typeof import(${JSON.stringify(moduleSpecifier(outputFile, file))});`);
        lines.push(`type MiddlewareLocals${index} = ObjectReturn<Middleware${index}["handler"]>;`);
    });
    const locals = middleware.reduce((merged, _, index) => `Merge<${merged}, MiddlewareLocals${index}>`, "{}");
    lines.push(`type Locals = ${locals};`);
    lines.push("");
    lines.push("type RouteContext<M> = Omit<BoringContext, \"params\" | \"query\" | \"body\" | \"session\" | \"services\" | \"locals\"> & {");
    lines.push('    readonly params: SchemaOutput<M, "params", BoringContext["params"]>;');
    lines.push('    readonly query: SchemaOutput<M, "query", BoringContext["query"]>;');
    lines.push('    readonly body: SchemaOutput<M, "body", BoringContext["body"]>;');
    lines.push("    readonly session: M extends { authentication: true } | { authorization: unknown } ? Session : Session | undefined;");
    lines.push("    readonly services: Readonly<Services>;");
    lines.push("    readonly locals: Locals;");
    lines.push("};");
    lines.push("type AuthorizationIsValid<M> = M extends { authorization: infer R } ? R extends AuthorizationRule ? true : false : true;");
    lines.push("");

    for (const route of routes.sort((left, right) => left.method.localeCompare(right.method))) {
        const prefix = typeName(route.method);
        lines.push(`type ${prefix}Module = typeof import(${JSON.stringify(moduleSpecifier(outputFile, route.file))});`);
        lines.push(`export type ${prefix}Context = RouteContext<${prefix}Module>;`);
        lines.push(`export type ${prefix}Output = SchemaOutput<${prefix}Module, "output", unknown>;`);
        lines.push(`export type ${prefix}Handler = AuthorizationIsValid<${prefix}Module> extends true ? (context: ${prefix}Context) => MaybePromise<SchemaInput<${prefix}Module, "output", unknown>> : never;`);
        lines.push("");
    }
    return `${lines.join("\n")}\n`;
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

/** Generates Svelte-style virtual $types modules for every route folder. */
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
    const tree = scan(api);

    rejectSymbolicLinkPath(root, generatedApiRoot);
    rmSync(generatedApiRoot, { recursive: true, force: true });
    const files: string[] = [];
    const routesByDirectory = new Map<string, RouteSource[]>();
    for (const route of tree.routes) {
        const current = routesByDirectory.get(route.directory) ?? [];
        current.push(route);
        routesByDirectory.set(route.directory, current);
    }

    for (const [directory, routes] of routesByDirectory) {
        const output = join(generatedApiRoot, relative(api, directory), "$types.d.ts");
        mkdirSync(dirname(output), { recursive: true });
        writeFileSync(output, generatedFile(output, routes, tree.setup, tree.auth));
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
    writeFileSync(join(root, ".boring", "tsconfig.json"), `${JSON.stringify({
        compilerOptions: { rootDirs: ["..", "./types"] },
    }, null, 2)}\n`);

    return { apiDirectory: api, generatedRoot, files };
}
