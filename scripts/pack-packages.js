const { mkdirSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { resolve } = require("node:path");
const { packages } = require("./workspaces");

if (process.argv.length !== 3) throw new Error("Usage: node scripts/pack-packages.js <output-directory>");
const output = resolve(process.argv[2]);
mkdirSync(output, { recursive: true });
for (const { directory } of packages()) {
    const result = spawnSync("pnpm", ["pack", "--pack-destination", output], { cwd: directory, stdio: "inherit" });
    if (result.status !== 0) {
        process.exitCode = result.status ?? 1;
        break;
    }
}
