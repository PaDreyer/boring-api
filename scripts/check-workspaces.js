const assert = require("node:assert/strict");
const { readdirSync, readFileSync } = require("node:fs");
const { builtinModules, createRequire } = require("node:module");
const { join, resolve, relative, isAbsolute } = require("node:path");
const { packages } = require("./workspaces");

const workspaces = packages(); // Also rejects cycles involving test dependencies.
const compiler = workspaces.find(entry => entry.manifest.name === "@boringapi/compiler");
const compilerRequire = createRequire(join(compiler.directory, "package.json"));
const ts = compilerRequire("typescript");
const { moduleLiteral } = compilerRequire("@boringapi/compiler");
const names = new Set(workspaces.map(entry => entry.manifest.name));
const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, "")));
function files(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
        ? files(join(directory, entry.name)) : entry.name.endsWith(".ts") ? [join(directory, entry.name)] : []);
}
for (const { directory, manifest } of workspaces) {
    for (const [name, version] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
        if (names.has(name)) assert.equal(version, "workspace:^", `${manifest.name}: use workspace:^ for ${name}`);
    }
    for (const file of files(join(directory, "src"))) {
        const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
        function check(specifier) {
            if (specifier.startsWith(".")) {
                const target = relative(directory, resolve(file, "..", specifier));
                assert.ok(!target.startsWith("..") && !isAbsolute(target), `${file}: cross-package relative import ${specifier}`);
            } else if (!builtins.has(specifier.replace(/^node:/, ""))) {
                const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
                assert.ok(manifest.dependencies?.[name] || manifest.peerDependencies?.[name], `${file}: undeclared production dependency ${name}`);
                const workspace = workspaces.find(entry => entry.manifest.name === name);
                if (workspace) {
                    const subpath = specifier === name ? "." : `.${specifier.slice(name.length)}`;
                    assert.ok(Object.hasOwn(workspace.manifest.exports, subpath), `${file}: private workspace import ${specifier}`);
                }
            }
        }
        function visit(node) {
            if (ts.isStringLiteralLike(node) && moduleLiteral(node)) check(node.text);
            if (ts.isCallExpression(node) && node.arguments.length && ts.isStringLiteralLike(node.arguments[0]) &&
                ts.isPropertyAccessExpression(node.expression) && node.expression.getText(source) === "require.resolve") check(node.arguments[0].text);
            ts.forEachChild(node, visit);
        }
        visit(source);
    }
}
const core = workspaces.find(entry => entry.manifest.name === "@boringapi/core").manifest;
for (const name of Object.keys({ ...core.dependencies, ...core.peerDependencies, ...core.optionalDependencies })) {
    assert.ok(!names.has(name) && !["typescript", "ts-node"].includes(name), `Core depends on tooling: ${name}`);
}
console.log(`Verified ${workspaces.length} package boundaries, dependency declarations and build order.`);
