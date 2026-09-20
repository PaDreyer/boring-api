import { existsSync, readFileSync, statSync } from "fs";
import { isAbsolute, join, resolve } from "path";
import ts from "typescript";
import { BoringApi } from "@boringapi/core";
import { formatHost, inside, readConfiguration } from "@boringapi/compiler";

export interface StartOptions {
    apiDirectory?: string;
    outputDirectory?: string;
    projectFile?: string;
}

/** Start the compiled worker owner without opening an HTTP listener. */
export async function startWorker(root: string, options: StartOptions = {}) {
    const application = await new BoringApi().createApp(resolveStartDirectory(root, options));
    return application;
}

/** Development convenience for launching an existing compiled application. */
export function startProject(root: string, options: StartOptions = {}, port = 4040) {
    return new BoringApi().listen(resolveStartDirectory(root, options), port);
}

function metadata(file: string): Record<string, unknown> {
    let value: unknown;
    try { value = JSON.parse(readFileSync(file, "utf8")); }
    catch { throw new Error(`Cannot read build metadata at ${file}. Run boring build before boring start.`); }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`Invalid build metadata at ${file}. Run boring build again.`);
    }
    return value as Record<string, unknown>;
}

function relativeDirectory(parent: string, path: unknown, file: string): string {
    if (typeof path !== "string" || isAbsolute(path) || !inside(parent, resolve(parent, path))) {
        throw new Error(`Invalid directory in build metadata at ${file}. Run boring build again.`);
    }
    return resolve(parent, path);
}

function directory(path: string): string {
    if (!existsSync(path) || !statSync(path).isDirectory()) {
        throw new Error(`Compiled API directory does not exist: ${path}. Run boring build first, or select a build with --out-dir.`);
    }
    return path;
}

/** Locate emitted routes without loading source modules or regenerating types. */
export function resolveStartDirectory(root: string, options: StartOptions): string {
    if ([options.apiDirectory, options.outputDirectory, options.projectFile].filter(value => value !== undefined).length > 1) {
        throw new Error("Choose one start target: a compiled API directory, --out-dir, or --project.");
    }
    if (options.apiDirectory !== undefined) return directory(resolve(root, options.apiDirectory));

    let output: string;
    if (options.outputDirectory !== undefined) {
        output = resolve(root, options.outputDirectory);
    } else if (options.projectFile !== undefined) {
        const configuration = readConfiguration(root, options.projectFile);
        // Starting compiled output does not require source files to remain present.
        const errors = configuration.errors.filter(error => error.code !== 18002 && error.code !== 18003);
        if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, formatHost(root)));
        output = resolve(configuration.options.outDir ?? join(root, "dist"));
    } else {
        const reference = join(root, ".boring", "build.json");
        if (existsSync(reference)) {
            const build = metadata(reference);
            if (build.version !== 1) throw new Error(`Unsupported build metadata at ${reference}. Run boring build again.`);
            output = relativeDirectory(root, build.outputDirectory, reference);
        } else output = join(root, "dist");
    }

    const file = join(output, ".boring-build.json");
    const build = metadata(file);
    if (build.version !== 1) throw new Error(`Unsupported build metadata at ${file}. Run boring build again.`);
    return directory(relativeDirectory(output, build.apiDirectory, file));
}
