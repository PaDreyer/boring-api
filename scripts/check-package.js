const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } = require("node:fs");
const { createRequire } = require("node:module");
const { tmpdir } = require("node:os");
const { dirname, join, relative, resolve, sep } = require("node:path");

// Check the archive consumers actually receive, independently of the source tree.
assert.ok(process.argv[2], "Usage: node scripts/check-package.js <package.tgz>");
const archive = resolve(process.argv[2]);
function tar(...args) {
    const result = spawnSync("tar", args, { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result.stdout;
}
const entries = tar("-tzf", archive).trim().split("\n");
for (const entry of entries) {
    assert.ok(entry.startsWith("package/") && !entry.split("/").includes(".."), `Invalid archive path: ${entry}`);
    assert.match(entry, /^package\/(?:package\.json|README\.md|LICENSE|dist\/.*|docs\/.*)$/, `Unexpected package file: ${entry}`);
}
const documents = readdirSync(join(__dirname, "../docs")).filter(name => name.endsWith(".md")).map(name => `docs/${name}`);
for (const file of ["package.json", "README.md", "LICENSE", "dist/cli.js", "dist/index.js", "dist/index.d.ts",
    "dist/client.js", "dist/client.d.ts", "dist/register.js", "dist/register.d.ts", ...documents]) {
    assert.ok(entries.includes(`package/${file}`), `Missing package file: ${file}`);
}

const temporary = mkdtempSync(join(tmpdir(), "boring-package-check-"));
try {
    tar("-xzf", archive, "-C", temporary);
    const consumer = join(temporary, "consumer");
    const scope = join(consumer, "node_modules/@boringapi");
    mkdirSync(scope, { recursive: true });
    const installed = join(scope, "core");
    renameSync(join(temporary, "package"), installed);
    const consumerRequire = createRequire(join(consumer, "package.json"));
    assert.equal(consumerRequire.resolve("@boringapi/core/agent-guide"), join(installed, "docs/agent-guide.md"));
    const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
    assert.equal(manifest.bin.boring, "./dist/cli.js");

    // These docs use ordinary inline Markdown links and GitHub heading anchors.
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
    let links = 0;
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
            links++;
        }
    }
    console.log(`Package verified: ${documents.length} guides, ${links} local documentation links, installed agent-guide locator and runtime entry points.`);
} finally {
    rmSync(temporary, { recursive: true, force: true });
}
