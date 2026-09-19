import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { generateTypes } from "@boringapi/typegen";

const repository = process.cwd();

function writeProject(root: string, compilerOptions: Record<string, unknown> = {}): void {
    writeFileSync(join(root, "package.json"), '{"name":"consumer","private":true}\n');
    writeFileSync(join(root, "tsconfig.json"), `${JSON.stringify({
        compilerOptions: {
            target: "ES2020",
            module: "commonjs",
            moduleResolution: "node",
            esModuleInterop: true,
            strict: true,
            skipLibCheck: true,
            baseUrl: ".",
            paths: {
                "@boringapi/core": [require.resolve("@boringapi/core").replace(/\.js$/, ".d.ts")],
                zod: [join(repository, "node_modules", "zod")],
            },
            ...compilerOptions,
        },
        include: ["api/**/*.ts"],
    }, null, 2)}\n`);
    mkdirSync(join(root, "api"));
}

function check(root: string): ReturnType<typeof spawnSync> {
    return spawnSync(process.execPath, [
        join(repository, "bin", "boring.cjs"),
        "check", "api",
    ], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, TS_NODE_PROJECT: join(repository, "tsconfig.json") },
    });
}

it("boring check reports mistakes through generated route types", () => {
    const result = spawnSync(process.execPath, [
        join(repository, "bin", "boring.cjs"),
        "check", "test/fixtures/type-error/api",
    ], { cwd: process.cwd(), encoding: "utf8" });

    assert.equal(result.status, 1);
    const diagnostics = `${result.stdout}\n${result.stderr}`;
    assert.match(diagnostics, /Property 'missing' does not exist/);
    assert.match(diagnostics, /Type 'string' is not assignable to type 'number'/);
});

it("boring check rejects unsupported convention files and invalid module contracts", () => {
    const badName = mkdtempSync(join(tmpdir(), "boring-api-check-name-"));
    const badContract = mkdtempSync(join(tmpdir(), "boring-api-check-contract-"));
    try {
        writeProject(badName);
        writeFileSync(join(badName, "api", "gett.ts"), "export const handler = () => null;\n");
        const nameResult = check(badName);
        assert.equal(nameResult.status, 1);
        assert.match(`${nameResult.stdout}\n${nameResult.stderr}`, /Unsupported endpoint file/);

        writeProject(badContract);
        writeFileSync(join(badContract, "api", "get.ts"), "export const handler = 42;\n");
        const contractResult = check(badContract);
        assert.equal(contractResult.status, 1);
        assert.match(`${contractResult.stdout}\n${contractResult.stderr}`, /RouteContract|handler/);
    } finally {
        rmSync(badName, { recursive: true, force: true });
        rmSync(badContract, { recursive: true, force: true });
    }
});

it("boring check reports tsconfig parse errors", () => {
    const root = mkdtempSync(join(tmpdir(), "boring-api-check-config-"));
    try {
        writeProject(root, { definitelyNotACompilerOption: true });
        writeFileSync(join(root, "api", "get.ts"), "export const handler = () => ({ ok: true });\n");
        const result = check(root);
        assert.equal(result.status, 1);
        assert.match(`${result.stdout}\n${result.stderr}`, /Unknown compiler option/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

it("boring check validates permission rules for annotated and unannotated handlers without executing hooks", () => {
    const root = mkdtempSync(join(tmpdir(), "boring-api-check-permissions-"));
    try {
        writeProject(root);
        writeFileSync(join(root, "api", "+auth.ts"), [
            'import type { Context, PermissionRule } from "@boringapi/core";',
            'throw new Error("check must not execute auth modules");',
            'export function authenticate() { return { permissions: ["orders:read"] as const }; }',
            'export function authorize(_ctx: Context, _rule: PermissionRule<"orders:read" | "orders:create">): void {}',
        ].join("\n"));
        const valid = [
            '"orders:read"',
            '{ allOf: ["orders:read", "orders:create"] } as const',
            '{ anyOf: ["orders:read", "orders:create"] } as const',
        ];
        for (const [index, rule] of valid.entries()) {
            const directory = join(root, "api", `valid-${index}`);
            mkdirSync(directory);
            writeFileSync(join(directory, "get.ts"), [
                'import type { GetHandler } from "./$types";',
                `export const authorization = ${rule};`,
                'export const handler: GetHandler = ctx => ({ permissions: ctx.session.permissions });',
            ].join("\n"));
            writeFileSync(join(directory, "post.ts"), [
                `export const authorization = ${rule};`,
                'export const handler = () => ({ ok: true });',
            ].join("\n"));
        }
        const good = check(root);
        assert.equal(good.status, 0, `${good.stdout}\n${good.stderr}`);

        const invalid = [
            '"orders:typo"',
            '{ allOf: ["orders:read", "orders:typo"] } as const',
            '{ anyOf: ["orders:read", "orders:typo"] } as const',
            '{ allOf: [] } as const',
            '{ anyOf: [] } as const',
            '{ allOf: ["orders:read"], anyOf: ["orders:create"] } as const',
            '["orders:read"] as const',
        ];
        for (const [index, rule] of invalid.entries()) {
            const directory = join(root, "api", `invalid-${index}`);
            mkdirSync(directory);
            writeFileSync(join(directory, "get.ts"), [
                `export const authorization = ${rule};`,
                'export const handler = () => ({ ok: true });',
            ].join("\n"));
        }
        const bad = check(root);
        assert.equal(bad.status, 1);
        const diagnostics = `${bad.stdout}\n${bad.stderr}`;
        for (const index of invalid.keys()) assert.ok(diagnostics.includes(`invalid-${index}/get`), diagnostics);
        assert.ok(!diagnostics.includes("check must not execute auth modules"), diagnostics);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

it("boring check preserves custom authorization contracts", () => {
    const root = mkdtempSync(join(tmpdir(), "boring-api-check-custom-auth-"));
    try {
        writeProject(root);
        writeFileSync(join(root, "api", "+auth.ts"), [
            'export function authorize(_ctx: unknown, _rule: { resource: "orders"; action: "read" }): void {}',
        ].join("\n"));
        writeFileSync(join(root, "api", "get.ts"), [
            'export const authorization = { resource: "orders", action: "read" } as const;',
            'export const handler = () => ({ ok: true });',
        ].join("\n"));
        const result = check(root);
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

it("generated locals use the last middleware value for duplicate keys", () => {
    const root = mkdtempSync(join(tmpdir(), "boring-api-check-locals-"));
    try {
        writeProject(root);
        mkdirSync(join(root, "api", "nested"));
        writeFileSync(join(root, "api", "+middleware.ts"),
            'export const handler = () => ({ value: "root" as const });\n');
        writeFileSync(join(root, "api", "nested", "+middleware.ts"),
            "export const handler = () => ({ value: 42 });\n");
        writeFileSync(join(root, "api", "nested", "get.ts"), [
            'import type { GetHandler } from "./$types";',
            "export const handler: GetHandler = ctx => {",
            "    const value: number = ctx.locals.value;",
            "    return { value };",
            "};",
            "",
        ].join("\n"));
        const result = check(root);
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

it("generated locals preserve every branch of an optional middleware overwrite", () => {
    const root = mkdtempSync(join(tmpdir(), "boring-api-check-union-locals-"));
    try {
        writeProject(root);
        mkdirSync(join(root, "api", "nested"));
        writeFileSync(join(root, "api", "+middleware.ts"),
            'export const handler = () => ({ value: "root" });\n');
        writeFileSync(join(root, "api", "nested", "+middleware.ts"), [
            "export const handler = (): { value: number } | {} =>",
            "    Math.random() > 0.5 ? { value: 42 } : {};",
            "",
        ].join("\n"));
        writeFileSync(join(root, "api", "nested", "get.ts"), [
            'import type { GetHandler } from "./$types";',
            "export const handler: GetHandler = ctx => {",
            "    const incorrectlyNarrowed: string = ctx.locals.value;",
            "    return { value: incorrectlyNarrowed };",
            "};",
            "",
        ].join("\n"));
        const result = check(root);
        assert.equal(result.status, 1);
        assert.match(`${result.stdout}\n${result.stderr}`, /not assignable to type 'string'/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
