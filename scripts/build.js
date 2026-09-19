const { chmodSync, rmSync } = require("fs");
const { spawnSync } = require("child_process");

rmSync("dist", { recursive: true, force: true });

const compiler = require.resolve("typescript/bin/tsc");
const result = spawnSync(process.execPath, [compiler, "-p", "tsconfig.json"], {
    stdio: "inherit",
});

if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
} else {
    chmodSync("dist/cli.js", 0o755);
}
