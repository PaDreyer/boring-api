const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const { tmpdir } = require("node:os");
const { dirname, join, relative, resolve, sep } = require("node:path");

const { packages: workspacePackages } = require("./workspaces");
const expectedPackages = workspacePackages();

// Install actual tarballs outside the workspace, where hoisting cannot hide missing dependencies.
assert.equal(process.argv.length - 2, expectedPackages.length, "Pass one tarball for each publishable workspace package.");
const temporary = mkdtempSync(join(tmpdir(), "boring-package-check-"));
const env = { ...process.env };
delete env.NODE_PATH;
delete env.NODE_OPTIONS;
function run(command, args, cwd = temporary) {
    const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
}
function tar(...args) { return run("tar", args); }
function json(file, value) { writeFileSync(file, JSON.stringify(value, null, 2) + "\n"); }
const documents = readdirSync(join(__dirname, "../docs")).filter(name => name.endsWith(".md")).map(name => `docs/${name}`);
function prose(file) { return readFileSync(file, "utf8").replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, ""); }
function anchors(file) {
    const counts = new Map();
    return [...prose(file).matchAll(/^#{1,6}\s+(.+)$/gm)].map(([, title]) => {
        const slug = title.toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, "").replace(/ /g, "-");
        const count = counts.get(slug) || 0;
        counts.set(slug, count + 1);
        return count ? `${slug}-${count}` : slug;
    });
}
function verifyArchive(archive) {
    const entries = tar("-tzf", archive).trim().split("\n");
    for (const entry of entries) {
        assert.ok(entry.startsWith("package/") && !entry.split("/").includes(".."), `Invalid archive path: ${entry}`);
        assert.match(entry, /^package\/(?:package\.json|README\.md|LICENSE|bin\/boring\.cjs|dist\/.*|docs\/.*)$/, `Unexpected package file: ${entry}`);
    }
    const manifest = JSON.parse(tar("-xOf", archive, "package/package.json"));
    const expected = expectedPackages.find(entry => entry.manifest.name === manifest.name)?.manifest;
    assert.ok(expected, `Unexpected package: ${manifest.name}`);
    assert.equal(manifest.version, expected.version);
    assert.deepEqual(manifest.exports, expected.exports);
    for (const [dependency, version] of Object.entries(expected.dependencies || {})) {
        const workspace = expectedPackages.find(entry => entry.manifest.name === dependency);
        assert.equal(manifest.dependencies[dependency], workspace ? `^${workspace.manifest.version}` : version,
            `${manifest.name}: incorrect dependency ${dependency}`);
    }
    const core = manifest.name === "@boringapi/core";
    const cli = manifest.name === "@boringapi/cli";
    const required = cli ? ["bin/boring.cjs", "dist/cli.js"] : ["dist/index.js", "dist/index.d.ts"];
    for (const file of ["package.json", "README.md", "LICENSE", ...required, ...documents]) {
        assert.ok(entries.includes(`package/${file}`), `${manifest.name}: missing ${file}`);
    }
    for (const entry of Object.values(manifest.exports)) {
        for (const file of typeof entry === "string" ? [entry] : Object.values(entry)) {
            assert.ok(entries.includes(`package/${file.replace(/^\.\//, "")}`), `${manifest.name}: missing export ${file}`);
        }
    }
    if (core) {
        for (const dependency of ["typescript", "ts-node", ...expectedPackages.filter(p => p.manifest.name !== manifest.name).map(p => p.manifest.name)]) {
            for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
                assert.equal(manifest[field]?.[dependency], undefined, `Core has a runtime dependency on ${dependency}`);
            }
        }
        for (const file of ["dist/cli.js", "dist/register.js", "dist/core/compiler.js", "dist/core/typegen.js"]) {
            assert.ok(!entries.includes(`package/${file}`), `Core contains tooling: ${file}`);
        }
    }
    if (cli) {
        assert.equal(manifest.bin.boring, "./bin/boring.cjs");
        assert.equal(manifest.dependencies.typescript, undefined);
        assert.equal(manifest.dependencies["ts-node"], undefined);
        for (const entry of entries.filter(file => file.startsWith("package/dist/"))) {
            assert.match(entry, /^package\/dist\/cli\.(?:js(?:\.map)?|d\.ts)$/, `CLI contains a tool implementation: ${entry}`);
        }
    } else assert.equal(manifest.bin, undefined);
    if (manifest.name === "@boringapi/compiler") assert.ok(manifest.dependencies.typescript && manifest.dependencies["ts-node"]);
    for (const lifecycle of ["prepare", "preinstall", "install", "postinstall"]) {
        assert.equal(manifest.scripts?.[lifecycle], undefined, `${manifest.name} must not compile during installation`);
    }
    const extracted = join(temporary, manifest.name.split("/")[1]);
    mkdirSync(extracted);
    tar("-xzf", archive, "-C", extracted);
    const installed = join(extracted, "package");
    for (const document of ["README.md", ...documents]) {
        const file = join(installed, document);
        for (const [, href] of prose(file).matchAll(/\[[^\]\n]+\]\(([^\s)]+)\)/g)) {
            if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
            const [path, fragment] = href.split("#");
            const target = path ? resolve(dirname(file), decodeURIComponent(path)) : file;
            const within = relative(installed, target);
            assert.ok(!within.startsWith(`..${sep}`) && within !== "..", `${document}: link leaves package: ${href}`);
            assert.ok(existsSync(target), `${document}: missing link target: ${href}`);
            if (fragment) assert.ok(anchors(target).includes(decodeURIComponent(fragment)), `${document}: missing heading: ${href}`);
        }
    }
    return { manifest, archive };
}
async function serves(directory, entry) {
    const child = spawn(process.execPath, [entry], { cwd: directory, env: { ...env, PORT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise(resolve => child.once("close", resolve));
    let output = "";
    try {
        const port = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`Startup timed out:\n${output}`)), 10000);
            const finish = (error, port) => { clearTimeout(timer); error ? reject(error) : resolve(port); };
            child.once("error", error => finish(error));
            child.once("exit", code => finish(new Error(`Server exited ${code}:\n${output}`)));
            const receive = chunk => {
                output += chunk.toString();
                const match = /Listening on port (\d+)/.exec(output);
                if (match) finish(undefined, Number(match[1]));
            };
            child.stdout.on("data", receive);
            child.stderr.on("data", receive);
        });
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { status: "ok" });
    } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        const force = setTimeout(() => child.kill("SIGKILL"), 5000);
        await exited;
        clearTimeout(force);
        assert.equal(child.exitCode, 0, `Graceful shutdown failed: ${output}`);
        assert.equal(child.signalCode, null);
        assert.match(output, /resource disposed/);
    }
}
async function main() {
    try {
        const packages = process.argv.slice(2).map(file => verifyArchive(resolve(file)));
        const core = packages.find(p => p.manifest.name === "@boringapi/core");
        const cli = packages.find(p => p.manifest.name === "@boringapi/cli");
        assert.equal(new Set(packages.map(p => p.manifest.name)).size, expectedPackages.length, "Duplicate or missing archive");
        assert.ok(core && cli);
        for (const entry of packages) assert.equal(entry.manifest.version, core.manifest.version, "Workspace packages share a release version");
        const consumer = join(temporary, "consumer");
        mkdirSync(consumer);
        // Exercise init's promotion of preinstalled runtime packages out of devDependencies.
        json(join(consumer, "package.json"), { name: "package-check", private: true,
            devDependencies: { ...Object.fromEntries(packages.map(p => [p.manifest.name, `file:${p.archive}`])),
                zod: core.manifest.peerDependencies.zod } });
        run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], consumer);
        const consumerRequire = createRequire(join(consumer, "package.json"));
        const executable = join(dirname(consumerRequire.resolve("@boringapi/cli/package.json")), cli.manifest.bin.boring);
        run(process.execPath, [executable, "init", ".", "--dir", "src/http"], consumer);
        const initialized = JSON.parse(readFileSync(join(consumer, "package.json"), "utf8"));
        for (const name of ["@boringapi/core", "zod"]) {
            assert.ok(initialized.dependencies[name], `${name} must be a runtime dependency after init`);
            assert.equal(initialized.devDependencies[name], undefined);
        }
        run("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], consumer);
        writeFileSync(join(consumer, "src/infra/lifetime.ts"), `export function acquire() {
    return { close() { console.info("resource disposed"); } };
}
`);
        writeFileSync(join(consumer, "src/http/+setup.ts"), `import type { SetupContext } from "./$types";
import { createHealth } from "$modules/health/facade";
import { acquire } from "$infra/lifetime";
export function setup(ctx: SetupContext) {
    const resource = acquire();
    ctx.onClose("fixture", () => resource.close());
    return { health: createHealth() };
}
`);
        writeFileSync(join(consumer, "src/server.ts"), `import { join } from "path";
import { BoringApi } from "@boringapi/core";
async function main() {
    const app = await new BoringApi().createApp(join(__dirname, "http"));
    const server = await app.listen(0);
    console.info("Listening on port " + (server.address() as import("net").AddressInfo).port);
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
        void app.close().catch(error => { console.error(error); process.exitCode = 1; });
    });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
`);
        const consumerConfig = JSON.parse(readFileSync(join(consumer, "tsconfig.json"), "utf8"));
        consumerConfig.include.push("src/server.ts");
        json(join(consumer, "tsconfig.json"), consumerConfig);
        run(process.execPath, [executable, "build", "src/http"], consumer);
        const publicApis = {
            "@boringapi/compiler": "readConfiguration",
            "@boringapi/compiler/register": "registerTypeScript",
            "@boringapi/typegen": "generateTypes",
            "@boringapi/analyzer": "analyzeProject",
            "@boringapi/build": "buildProject",
            "@boringapi/scaffold": "initializeProject",
            "@boringapi/dev": "startDevServer",
        };
        for (const [name, method] of Object.entries(publicApis)) assert.equal(typeof consumerRequire(name)[method], "function", name);
        // Public declaration dependencies must also resolve outside the workspace.
        writeFileSync(join(consumer, "tool-apis.ts"), Object.entries(publicApis).map(([name, method]) =>
            `import { ${method} } from "${name}"; void ${method};`).join("\n"));
        const compilerRequire = createRequire(consumerRequire.resolve("@boringapi/compiler/package.json"));
        run(process.execPath, [compilerRequire.resolve("typescript/bin/tsc"), "--noEmit", "--strict", "--esModuleInterop",
            "--target", "es2020", "--module", "commonjs", "tool-apis.ts"], consumer);
        // Relocate the artifact into a fresh deployment containing no source or workspace links.
        const deployment = join(temporary, "deployment");
        mkdirSync(deployment);
        cpSync(join(consumer, "package.json"), join(deployment, "package.json"));
        cpSync(join(consumer, "package-lock.json"), join(deployment, "package-lock.json"));
        renameSync(join(consumer, "dist"), join(deployment, "artifact"));
        run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], deployment);
        rmSync(consumer, { recursive: true });
        const productionRequire = createRequire(join(deployment, "package.json"));
        for (const name of ["typescript", "ts-node", ...packages.filter(p => p !== core).map(p => p.manifest.name)]) {
            assert.throws(() => productionRequire.resolve(name), { code: "MODULE_NOT_FOUND" }, `${name} must not be installed in production`);
        }
        assert.equal(typeof productionRequire("@boringapi/core").BoringApi, "function");
        assert.equal(typeof productionRequire("@boringapi/core/client").createClient, "function");
        assert.equal(typeof productionRequire("@boringapi/core/conventions").scanApi, "function");
        assert.ok(existsSync(productionRequire.resolve("@boringapi/core/agent-guide")));
        await serves(deployment, join(deployment, "artifact/boring-start.cjs"));
        await serves(deployment, join(deployment, "artifact/server.js"));
        const controlled = run(process.execPath, ["-e", `
const assert = require("node:assert/strict");
const { BoringApi } = require("@boringapi/core");
const { readHealth } = require("./artifact/executions/health.js");
(async () => {
    const app = await new BoringApi().createApp(require("node:path").resolve("artifact/http"), { env: process.env });
    try {
        assert.deepEqual(await readHealth(app, { kind: "machine", id: "package-check", permissions: [] }), { status: "ok" });
        await assert.rejects(app.execute({ identity: { kind: "machine", id: "deadline", permissions: [] }, timeoutMs: 10 }, ({ execution }) =>
            new Promise((_resolve, reject) => execution.signal.addEventListener("abort", () => reject(execution.signal.reason), { once: true }))),
            { code: "deadline" });
        const starting = assert.rejects(app.listen(0), { code: "unavailable" });
        await app.close();
        await starting;
    } finally { await app.close(); }
    assert.equal(app.state, "closed");
    await assert.rejects(readHealth(app, { kind: "machine", id: "closed", permissions: [] }), { code: "unavailable" });
    console.info("controlled lifecycle verified");
})().catch(error => { console.error(error); process.exitCode = 1; });
`], deployment);
        assert.match(controlled, /resource disposed/);
        assert.match(controlled, /controlled lifecycle verified/);

        console.log(`All ${packages.length} tarballs verified: public APIs and declarations, documentation, CLI build, relocated HTTP/custom-server and controlled execution with cleanup, and npm ci --omit=dev without development packages.`);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
