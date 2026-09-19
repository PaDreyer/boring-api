const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { resolve, join } = require("node:path");
const { packages } = require("./workspaces");

const entries = packages();
const versions = new Set(entries.map(entry => entry.manifest.version));
assert.equal(versions.size, 1, "All publishable packages must share a release version");
const [version] = versions;
if (process.env.GITHUB_REF_NAME) assert.equal(process.env.GITHUB_REF_NAME, `v${version}`, "Tag must match every package version");
if (process.argv[2] === "--version") {
    console.log(version);
} else {
    assert.equal(process.argv.length, 3, "Usage: node scripts/release-plan.js <artifact-directory> | --version");
    const lines = entries.map(({ manifest }) => {
        const file = join(resolve(process.argv[2]), `${manifest.name.slice(1).replace("/", "-")}-${version}.tgz`);
        const result = spawnSync("tar", ["-xOf", file, "package/package.json"], { encoding: "utf8" });
        assert.ifError(result.error);
        assert.equal(result.status, 0, `Missing or unreadable archive: ${file}\n${result.stderr}`);
        const packed = JSON.parse(result.stdout);
        assert.equal(packed.name, manifest.name);
        assert.equal(packed.version, version);
        const integrity = `sha512-${createHash("sha512").update(readFileSync(file)).digest("base64")}`;
        return [manifest.name, file, integrity].join("\t");
    });
    console.log(lines.join("\n"));
}
