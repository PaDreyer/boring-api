import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { it } from "node:test";

async function response(port: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
        get(`http://127.0.0.1:${port}`, res => {
            const chunks: Buffer[] = [];
            res.on("data", chunk => chunks.push(Buffer.from(chunk)));
            res.on("end", () => {
                try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
                catch (error) { reject(error); }
            });
            res.on("error", reject);
        }).on("error", reject);
    });
}

it("boring dev reloads sibling modules and infra, including newly created directories", async () => {
    const repository = join(__dirname, "..");
    const root = mkdtempSync(join(tmpdir(), "boring-api-dev-"));
    const application = join(root, "app");
    const api = join(application, "http");
    mkdirSync(api, { recursive: true });
    writeFileSync(join(root, "package.json"), '{"name":"dev-consumer","private":true}\n');
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: {
        module: "commonjs", target: "ES2020", allowJs: true,
    }, include: ["app/**/*"] }));
    // Dev must use the same project configuration as check/build, rather than
    // accidentally selecting a different tsconfig beside the API directory.
    writeFileSync(join(application, "tsconfig.json"), '{"compilerOptions":{"module":"esnext"}}');
    writeFileSync(join(api, "get.js"), 'exports.handler = () => ({ value: "initial" });\n');

    const child = spawn(process.execPath, [
        "-r", require.resolve("ts-node/register"), join(repository, "src", "cli.ts"),
        "dev", "app/http", "--port", "0",
    ], {
        cwd: root,
        env: { ...process.env, TS_NODE_PROJECT: join(repository, "tsconfig.json") },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk.toString(); });
    child.stderr.on("data", chunk => { output += chunk.toString(); });
    child.on("error", error => { output += error.stack; });
    const ports = () => [...output.matchAll(/Listening on port (\d+)/g)].map(match => Number(match[1]));
    const nextServer = async (previous: number) => {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
            const started = ports();
            if (started.length > previous) return started[started.length - 1];
            await delay(25);
        }
        assert.fail(`Dev server did not restart:\n${output}`);
    };
    const change = async (write: () => void, expected: string) => {
        const previous = ports().length;
        write();
        assert.deepEqual(await response(await nextServer(previous)), { value: expected });
    };

    try {
        assert.deepEqual(await response(await nextServer(0)), { value: "initial" });

        const module = join(application, "modules", "orders");
        const infra = join(application, "infra");
        // Adding sibling roots alone must be detected, without any API file change.
        await change(() => {
            mkdirSync(module, { recursive: true });
            writeFileSync(join(module, "facade.js"),
                'exports.read = () => require("$infra/store").value;\n');
        }, "initial");
        await change(() => {
            mkdirSync(infra);
            writeFileSync(join(infra, "store.js"), 'exports.value = "stored";\n');
        }, "initial");

        // Connect the new facade, then change only its dependencies.
        await change(() => {
            writeFileSync(join(api, "+setup.js"),
                'exports.setup = () => ({ orders: require("$modules/orders/facade") });\n');
            writeFileSync(join(api, "get.js"),
                'exports.handler = ctx => ({ value: ctx.services.orders.read() });\n');
        }, "stored");

        await change(() => {
            writeFileSync(join(infra, "store.js"), 'exports.value = "changed storage";\n');
        }, "changed storage");
        await change(() => {
            writeFileSync(join(module, "facade.js"),
                'exports.read = () => "facade: " + require("$infra/store").value;\n');
        }, "facade: changed storage");

        const internal = join(module, "internal");
        await change(() => {
            mkdirSync(internal);
            writeFileSync(join(internal, "label.js"), 'exports.value = "nested";\n');
            writeFileSync(join(module, "facade.js"),
                'exports.read = () => require("./internal/label").value;\n');
        }, "nested");
        await change(() => {
            writeFileSync(join(internal, "label.js"), 'exports.value = "nested change";\n');
        }, "nested change");

        // Recreating a watched directory must attach to its new filesystem entry.
        await change(() => {
            rmSync(internal, { recursive: true });
            mkdirSync(internal);
            writeFileSync(join(internal, "label.js"), 'exports.value = "recreated";\n');
        }, "recreated");
        await change(() => {
            writeFileSync(join(internal, "label.js"), 'exports.value = "still watched";\n');
        }, "still watched");

        const previous = ports().length;
        const currentPort = ports()[previous - 1];
        mkdirSync(join(application, "dist"));
        writeFileSync(join(application, "dist", "output.js"), "// build output\n");
        await delay(300);
        assert.equal(ports().length, previous, "Build output should not restart the server");
        assert.deepEqual(await response(currentPort), { value: "still watched" });
    } finally {
        if (child.exitCode === null && child.signalCode === null) {
            const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
            child.kill("SIGTERM");
            await exited;
        }
        rmSync(root, { recursive: true, force: true });
    }
});
