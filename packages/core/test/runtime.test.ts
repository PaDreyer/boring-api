import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { it } from "node:test";

it("loads every runtime entry point without development tools", () => {
    const result = spawnSync(process.execPath, ["-e", `
        const assert = require("node:assert/strict");
        const Module = require("node:module");
        const load = Module._load;
        Module._load = function(id, ...args) {
            assert.ok(!["typescript", "ts-node", "@boringapi/compiler", "@boringapi/typegen", "@boringapi/analyzer", "@boringapi/build", "@boringapi/scaffold", "@boringapi/dev", "@boringapi/cli"].some(name => id === name || id.startsWith(name + "/")), "Runtime loaded " + id);
            return load.call(this, id, ...args);
        };
        assert.equal(typeof require("./dist").BoringApi, "function");
        assert.equal(typeof require("./dist/client").createClient, "function");
        assert.equal(typeof require("./dist/core/conventions").scanApi, "function");
    `], { cwd: join(__dirname, ".."), encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
});
