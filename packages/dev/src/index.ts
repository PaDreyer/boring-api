import { ChildProcess, spawn } from "child_process";
import { readdirSync, watch, FSWatcher } from "fs";
import { basename, dirname, join, resolve } from "path";
import { synchronizeProject } from "@boringapi/analyzer";

export interface DevServer { close(): Promise<void>; }

function watchDirectories(directory: string, onChange: () => void): () => void {
    const parent = dirname(directory);
    const names = new Set([basename(directory), "modules", "infra", "web"]);
    let watchers: FSWatcher[] = [];
    let timer: NodeJS.Timeout | undefined;
    let stopped = false;
    const scheduleRefresh = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(refresh, 50);
    };
    const refresh = () => {
        if (stopped) return;
        for (const watcher of watchers) watcher.close();
        watchers = [];
        const visit = (current: string) => {
            try {
                const entries = readdirSync(current, { withFileTypes: true });
                watchers.push(watch(current, (event) => {
                    if (stopped) return;
                    onChange();
                    if (event === "rename") scheduleRefresh();
                }));
                for (const entry of entries) {
                    if (entry.isDirectory()) visit(join(current, entry.name));
                }
            } catch (error) {
                // A source directory may be absent, removed or replaced during a save.
                const code = (error as NodeJS.ErrnoException).code;
                if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
            }
        };
        // Notice sibling roots created after dev starts, without watching build output.
        watchers.push(watch(parent, (_event, filename) => {
            if (stopped || (filename !== null && !names.has(filename.toString()))) return;
            onChange();
            scheduleRefresh();
        }));
        for (const name of names) visit(join(parent, name));
    };
    refresh();
    return () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        for (const watcher of watchers) watcher.close();
    };
}

export function startDevServer(root: string, apiDirectory: string, port = 4040, projectFile?: string): DevServer {
    root = resolve(root);
    const api = resolve(root, apiDirectory);
    const sync = () => {
        const result = synchronizeProject(root, apiDirectory, projectFile);
        console.info(`Generated ${result.files.length} type file${result.files.length === 1 ? "" : "s"}.`);
    };
    sync();
    let child: ChildProcess | undefined;
    let timer: NodeJS.Timeout | undefined;
    let restartRequested = false;
    let stopping = false;
    const terminating = new WeakMap<ChildProcess, Promise<void>>();
    const terminate = (current: ChildProcess): Promise<void> => {
        if (current.exitCode !== null || current.signalCode !== null) return Promise.resolve();
        const pending = terminating.get(current);
        if (pending) return pending;
        const finished = new Promise<void>(resolve => {
            const force = setTimeout(() => current.kill("SIGKILL"), 5000);
            current.once("close", () => { clearTimeout(force); resolve(); });
            current.kill("SIGTERM");
        });
        terminating.set(current, finished);
        return finished;
    };

    const start = () => {
        if (stopping) return;
        const spawned = spawn(process.execPath, [join(__dirname, "worker.js"), root, api, String(port),
            ...(projectFile ? [resolve(root, projectFile)] : [])], {
            cwd: root,
            stdio: "inherit",
        });
        spawned.once("error", error => console.error(error));
        child = spawned;
        spawned.once("exit", () => {
            if (child === spawned) child = undefined;
            if (restartRequested && !stopping) {
                restartRequested = false;
                start();
            }
        });
    };
    const restart = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            try {
                sync();
                if (child && child.exitCode === null) {
                    restartRequested = true;
                    void terminate(child);
                } else {
                    restartRequested = false;
                    start();
                }
            } catch (error) {
                console.error(error);
            }
        }, 100);
    };
    const closeWatchers = watchDirectories(api, restart);
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
        if (closing) return closing;
        stopping = true;
        restartRequested = false;
        if (timer) clearTimeout(timer);
        closeWatchers();
        const current = child;
        closing = current ? terminate(current) : Promise.resolve();
        return closing;
    };
    start();
    return { close };
}
