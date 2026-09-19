import { formatHost } from "@boringapi/compiler";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import ts from "typescript";
import { analyzeProject } from "../src";
import { readConfiguration } from "@boringapi/compiler";

const repository = join(__dirname, "..");
function write(root: string, file: string, source: string) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), source);
}
function fixture() {
    const root = mkdtempSync(join(tmpdir(), "boring-hook-types-"));
    write(root, "package.json", '{"private":true}');
    write(root, "tsconfig.json", JSON.stringify({
        extends: "./.boring/tsconfig.json",
        compilerOptions: {
            module: "commonjs", target: "ES2020", moduleResolution: "node", esModuleInterop: true, strict: true,
            paths: { "@boringapi/core": [require.resolve("@boringapi/core").replace(/\.js$/, ".d.ts")] },
        },
        include: ["api/**/*.ts"],
    }));
    symlinkSync(join(repository, "node_modules"), join(root, "node_modules"), "dir");
    write(root, "api/+setup.ts", `
import type { SetupHandler } from "./$types";
throw new Error("hooks must not execute during type generation");
export const setup = ((ctx) => {
    ctx.logger.info("setup");
    return { settings: { name: "app", limit: 3 }, users: { find: (id: string) => ({ id }) } };
}) satisfies SetupHandler;
`);
    write(root, "api/+auth.ts", `
import type { AuthenticationContext, AuthorizationHandler } from "./$types";
export async function authenticate(ctx: AuthenticationContext) {
    const absent: undefined = ctx.session;
    const app: string = ctx.services.settings.name;
    // @ts-expect-error Authentication runs before middleware.
    ctx.locals.requestId;
    // @ts-expect-error Request input has not been validated.
    ctx.params.id;
    // @ts-expect-error Services have concrete application types.
    ctx.services.missing;
    if (ctx.request.header("authorization")) {
        return { user: ctx.services.users.find("user"), permissions: ["read"] as const };
    }
}
export const authorize = ((ctx, rule) => {
    const id: string = ctx.session.user.id;
    const request: string = ctx.locals.requestId;
    const overwritten: number = ctx.locals.value;
    const permission: "read" = rule;
    // @ts-expect-error Authorization also runs before input validation.
    ctx.params.id;
}) satisfies AuthorizationHandler<"read">;
`);
    write(root, "api/+middleware.ts", `
import type { MiddlewareHandler } from "./$types";
export const handler = ((ctx) => {
    const name: string = ctx.services.settings.name;
    const id: string | undefined = ctx.session?.user.id;
    // @ts-expect-error Session guards have not run yet.
    ctx.session.user.id;
    // @ts-expect-error This middleware has not returned its own locals yet.
    ctx.locals.requestId;
    return { requestId: "request", value: "root" };
}) satisfies MiddlewareHandler;
`);
    write(root, "api/items/+middleware.ts", `
import type { MiddlewareContext } from "./$types";
export async function handler(ctx: MiddlewareContext) {
    const request: string = ctx.locals.requestId;
    const previous: string = ctx.locals.value;
    // @ts-expect-error Only ancestor locals are available here.
    ctx.locals.section;
    // @ts-expect-error The route's schema has not run yet.
    ctx.params.id;
    return { value: 42, section: true as const };
}
`);
    write(root, "api/items/[id]/get.ts", `
import { z } from "zod";
import type { GetHandler } from "./$types";
export const params = z.object({ id: z.string() });
export const output = z.object({ id: z.string() });
export const authorization = "read";
export const handler: GetHandler = ctx => {
    const id: string = ctx.params.id;
    const value: number = ctx.locals.value;
    const sessionId: string = ctx.session.user.id;
    const limit: number = ctx.services.settings.limit;
    return { id };
};
`);
    write(root, "api/+envelope.ts", `
import type { EnvelopeContext } from "./$types";
export function handler(ctx: EnvelopeContext) {
    ctx.response.setHeader("x-typed", "yes");
    ctx.status(200);
    ctx.set("custom", ctx.request.method);
    ctx.setup.logger.info("envelope");
    const id: string = ctx.params.id;
    const sessionId: string = ctx.session.user.id;
    const value: number = ctx.locals.value;
    const result: string = ctx.payload.id;
    // @ts-expect-error Output is typed from the schema.
    ctx.payload.missing;
    const wrapped = { data: ctx.payload };
    ctx.payload = wrapped;
    return wrapped;
}
`);
    write(root, "api/+error.ts", `
import type { ErrorContext } from "./$types";
export function handler(ctx: ErrorContext, error: Error) {
    ctx.status(500);
    ctx.response.setHeader("x-error", ctx.request.method);
    ctx.set("cause", error);
    ctx.setup.logger.info("error");
    const value: string | number | undefined = ctx.locals.value;
    const request: string | undefined = ctx.locals.requestId;
    const id: string | undefined = ctx.session?.user.id;
    const app: string = ctx.services.settings.name;
    // @ts-expect-error Authentication may have failed.
    ctx.session.user.id;
    // @ts-expect-error Middleware may not have run yet.
    const guaranteed: string = ctx.locals.requestId;
    // @ts-expect-error Failure may precede input validation.
    ctx.params.id;
    return { message: error.message };
}
`);
    write(root, "api/items/+error.404.ts", `
import type { ErrorHandler } from "./$types";
export const handler = ((ctx, error) => {
    const previousOrCurrent: string | number | undefined = ctx.locals.value;
    return { message: error.message, app: ctx.services.settings.name };
}) satisfies ErrorHandler;
`);
    write(root, "api/public/get.ts", `
import { z } from "zod";
export const output = z.string();
export const envelope = false;
export const handler = () => "public";
`);
    write(root, "api/other/get.ts", `
import { z } from "zod";
export const output = z.string().transform(value => value.length);
export const handler = () => "other";
`);
    write(root, "api/other/+envelope.ts", `
import type { EnvelopeHandler } from "./$types";
export const handler = ((ctx) => {
    const parsed: number = ctx.payload;
    return { length: parsed };
}) satisfies EnvelopeHandler;
`);
    write(root, "api/orphan/+middleware.ts", `
import type { MiddlewareContext } from "./$types";
export function handler(ctx: MiddlewareContext) {
    const request: string = ctx.locals.requestId;
    return { orphan: request };
}
`);
    return root;
}
function checked(root: string) {
    const project = analyzeProject(root, "api");
    assert.equal(project.diagnostics.length, 0, ts.formatDiagnostics(project.diagnostics, formatHost(root)));
    assert.deepEqual(project.architecture, []);
    return project;
}

it("generates phase-correct contexts for every hook without casts, execution or circular inference", () => {
    const root = fixture();
    try {
        const project = checked(root);
        assert.ok(project.files.includes(join(root, ".boring/types/api/$types.d.ts")), "root has hooks but no route");
        assert.ok(project.files.includes(join(root, ".boring/types/api/orphan/$types.d.ts")), "unused hooks still receive types");
        // Existing module boundaries must also reject runtime imports of generated types.
        write(root, "api/orphan/+middleware.ts", 'import "./$types"; export const handler = () => ({});');
        assert.ok(analyzeProject(root, "api").architecture.some(error => error.code === "BORING107"));
    } finally { rmSync(root, { recursive: true, force: true }); }
});

it("exposes inferred hook services, session and ancestor locals to the ordinary TypeScript language service", () => {
    const root = fixture();
    try {
        checked(root);
        const config = readConfiguration(root);
        const service = ts.createLanguageService({
            getCompilationSettings: () => config.options,
            getScriptFileNames: () => config.fileNames,
            getScriptVersion: () => "1",
            getScriptSnapshot: file => { const text = ts.sys.readFile(file); return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text); },
            getCurrentDirectory: () => root,
            getDefaultLibFileName: options => ts.getDefaultLibFilePath(options),
            fileExists: ts.sys.fileExists, readFile: ts.sys.readFile, readDirectory: ts.sys.readDirectory,
            directoryExists: ts.sys.directoryExists, getDirectories: ts.sys.getDirectories,
            realpath: ts.sys.realpath,
        });
        try {
            const auth = join(root, "api/+auth.ts");
            const text = readFileSync(auth, "utf8");
            const diagnostics = service.getSemanticDiagnostics(auth);
            assert.equal(diagnostics.length, 0, ts.formatDiagnostics(diagnostics, formatHost(root)));
            const members = service.getCompletionsAtPosition(auth, text.indexOf("ctx.services.settings") + "ctx.services.".length, {})!;
            assert.ok(members.entries.some(entry => entry.name === "users"));
            assert.ok(members.entries.some(entry => entry.name === "settings"));
            const session = service.getCompletionsAtPosition(auth, text.indexOf("ctx.session.user") + "ctx.session.".length, {})!;
            assert.ok(session.entries.some(entry => entry.name === "user"));
            assert.ok(session.entries.some(entry => entry.name === "permissions"));
            const definition = service.getDefinitionAtPosition(auth, text.indexOf("settings.name") + "settings.".length)!;
            assert.ok(definition.some(entry => entry.fileName === join(root, "api/+setup.ts")));
            const middleware = join(root, "api/items/+middleware.ts");
            const source = readFileSync(middleware, "utf8");
            const locals = service.getCompletionsAtPosition(middleware, source.indexOf("ctx.locals.requestId") + "ctx.locals.".length, {})!;
            assert.ok(locals.entries.some(entry => entry.name === "requestId"));
            assert.ok(!locals.entries.some(entry => entry.name === "section"));
        } finally { service.dispose(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
});

it("refreshes hook types when application return types change", () => {
    const root = fixture();
    try {
        checked(root);
        const setup = join(root, "api/+setup.ts");
        writeFileSync(setup, readFileSync(setup, "utf8").replace('({ id })', '({ id: 42 })'));
        const project = analyzeProject(root, "api");
        assert.ok(project.diagnostics.some(error => error.file?.fileName === join(root, "api/+auth.ts") && error.code === 2322), ts.formatDiagnostics(project.diagnostics, formatHost(root)));
        assert.ok(project.diagnostics.some(error => error.file?.fileName === join(root, "api/items/[id]/get.ts") && error.code === 2322));
    } finally { rmSync(root, { recursive: true, force: true }); }
});

it("keeps previous locals when a middleware can return undefined", () => {
    const root = fixture();
    try {
        const file = join(root, "api/items/+middleware.ts");
        writeFileSync(file, readFileSync(file, "utf8").replace(
            'return { value: 42, section: true as const };',
            'return ctx.request.header("overwrite") ? { value: 42, section: true as const } : undefined;',
        ));
        const project = analyzeProject(root, "api");
        for (const file of ["+auth.ts", "+envelope.ts", "items/[id]/get.ts"]) {
            assert.ok(project.diagnostics.some(error => error.file?.fileName === join(root, "api", file) && error.code === 2322), ts.formatDiagnostics(project.diagnostics, formatHost(root)));
        }
    } finally { rmSync(root, { recursive: true, force: true }); }
});

it("generates contexts for hook-only applications and envelopes with only opted-out routes", () => {
    const root = fixture();
    try {
        rmSync(join(root, "api"), { recursive: true });
        write(root, "api/+setup.ts", `
import type { SetupContext } from "./$types";
export function setup(ctx: SetupContext) { ctx.logger.info("setup"); return { label: "app" }; }
`);
        write(root, "api/+middleware.ts", `
import type { MiddlewareContext } from "./$types";
export function handler(ctx: MiddlewareContext) { return { step: ctx.services.label.length }; }
`);
        write(root, "api/+envelope.ts", `
import type { EnvelopeContext } from "./$types";
export function handler(ctx: EnvelopeContext) {
    const step: number = ctx.locals.step;
    const label: string = ctx.services.label;
    return { data: ctx.payload, step, label };
}
`);
        write(root, "api/+error.ts", `
import type { ErrorHandler } from "./$types";
export const handler = ((ctx, error) => ({ label: ctx.services.label, message: error.message })) satisfies ErrorHandler;
`);
        checked(root);
        write(root, "api/get.ts", 'export const envelope = false; export const handler = () => 42;');
        checked(root);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

it("does not infer an absent envelope payload when earlier hooks can have assigned it", () => {
    const root = fixture();
    try {
        write(root, "api/items/[id]/get.ts", `
export const authorization = "read";
export const handler = () => undefined;
`);
        const middleware = join(root, "api/+middleware.ts");
        writeFileSync(middleware, readFileSync(middleware, "utf8").replace(
            'return { requestId: "request", value: "root" };',
            'ctx.payload = { earlier: true }; return { requestId: "request", value: "root" };',
        ));
        write(root, "api/+envelope.ts", `
import type { EnvelopeContext } from "./$types";
export function handler(ctx: EnvelopeContext) {
    // @ts-expect-error An undefined handler result can retain an earlier payload.
    const absent: undefined = ctx.payload;
    return { data: ctx.payload };
}
`);
        checked(root);
    } finally { rmSync(root, { recursive: true, force: true }); }
});
