const { cpSync, rmSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { createRequire } = require("node:module");
const { join } = require("node:path");

const packageRoot = process.cwd();
const packageRequire = createRequire(join(packageRoot, "package.json"));
const repositoryRoot = join(__dirname, "..");

rmSync(join(packageRoot, "dist"), { recursive: true, force: true });
const result = spawnSync(process.execPath, [packageRequire.resolve("typescript/bin/tsc"), "-p", "tsconfig.json"], {
    stdio: "inherit",
});
if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
} else {
    rmSync(join(packageRoot, "docs"), { recursive: true, force: true });
    for (const file of ["README.md", "LICENSE", "docs"]) {
        cpSync(join(repositoryRoot, file), join(packageRoot, file), { recursive: true });
    }
}
