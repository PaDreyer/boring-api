const { chmodSync, cpSync, rmSync } = require("fs");
const { spawnSync } = require("child_process");
const { join } = require("path");

const packageRoot = join(__dirname, "..");
const repositoryRoot = join(packageRoot, "../..");
process.chdir(packageRoot);

rmSync("dist", { recursive: true, force: true });

const compiler = require.resolve("typescript/bin/tsc");
const result = spawnSync(process.execPath, [compiler, "-p", "tsconfig.json"], {
    stdio: "inherit",
});

if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
} else {
    chmodSync("dist/cli.js", 0o755);
    rmSync("docs", { recursive: true, force: true });
    for (const file of ["README.md", "LICENSE", "docs"]) {
        cpSync(join(repositoryRoot, file), join(packageRoot, file), { recursive: true });
    }
}
