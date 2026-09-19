import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { generateTypes } from "../src";

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
                "@boringapi/core": [join(repository, "src", "index.ts")],
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
        "-r", require.resolve("ts-node/register"),
        join(repository, "src", "cli.ts"),
        "check", "api",
    ], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, TS_NODE_PROJECT: join(repository, "tsconfig.json") },
    });
}

it("boring check reports mistakes through generated route types", () => {
    const result = spawnSync(process.execPath, [
        "-r", require.resolve("ts-node/register"),
        join(process.cwd(), "src", "cli.ts"),
        "check", "test/fixtures/type-error/api",
    ], { cwd: process.cwd(), encoding: "utf8" });

    assert.equal(result.status, 1);
    const diagnostics = `${result.stdout}\n${result.stderr}`;
    assert.match(diagnostics, /Property 'missing' does not exist/);
    assert.match(diagnostics, /Type 'string' is not assignable to type 'number'/);
});

it("never writes generated types outside .boring when the API is outside the project", () => {
    const base = mkdtempSync(join(tmpdir(), "boring-api-containment-"));
    const root = join(base, "nested", "project");
    const externalApi = join(base, "api");
    const unrelated = join(root, "api");
    try {
        mkdirSync(root, { recursive: true });
        mkdirSync(externalApi);
        mkdirSync(unrelated);
        writeFileSync(join(externalApi, "get.ts"), "export const handler = () => ({ ok: true });\n");
        writeFileSync(join(unrelated, "KEEP"), "do not delete\n");

        assert.throws(() => generateTypes(root, externalApi), /must be inside the project root/);
        assert.equal(readFileSync(join(unrelated, "KEEP"), "utf8"), "do not delete\n");
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

it("rejects symbolic links that redirect generated types outside the project", () => {
    const base = mkdtempSync(join(tmpdir(), "boring-api-output-link-"));
    const root = join(base, "project");
    const api = join(root, "api");
    const victim = join(base, "victim");
    try {
        mkdirSync(api, { recursive: true });
        mkdirSync(join(root, ".boring"));
        mkdirSync(join(victim, "api"), { recursive: true });
        writeFileSync(join(api, "get.ts"), "export const handler = () => ({ ok: true });\n");
        writeFileSync(join(victim, "api", "KEEP"), "do not delete\n");
        symlinkSync(victim, join(root, ".boring", "types"), "dir");

        assert.throws(() => generateTypes(root, api), /must not contain symbolic links/);
        assert.equal(readFileSync(join(victim, "api", "KEEP"), "utf8"), "do not delete\n");
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
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
