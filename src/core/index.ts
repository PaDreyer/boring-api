import {readdirSync, fstatSync, Dirent} from "fs";
import {basename, normalize, join, parse} from 'path';
import express, { Request, Response } from 'express';
import {Logger} from "./logger";
import {getLogger} from "./utils";

export class Setup extends Map {
    mergeWithDefault() {
        if (!this.has("logger")) {
            this.set("logger", new Logger());
        }
    }
}

export class Context extends Map {
    constructor() {
        super();
    }
}

enum FileType {
    handler= "handler",
    folder = "folder",
    input = "input",
    output = "output",
    unknown = "unknown",
    setup = "setup",
}

type File = {
    type: FileType;
    meta?: any;
}

type Node = {
    parent: Node | undefined;
    nodes: Node[];
    name: string;
    path: string;
    file: File;
    depth: number;
}

function getFilesOfType(nodes: Node[], type: FileType) {
    const handler: Node[] = [];

    for (const node of nodes) {
        if (node.file.type === type) {
            handler.push(node);
        } else if (node.file.type === FileType.folder) {
            handler.push(...getFilesOfType(node.nodes, type));
        }
    }

    return handler;
}

function createExpressHandler(setup: Setup, handler: (ctx: Context) => Promise<unknown>) {
    return async (req: Request, res: Response) => {
        const logger = getLogger(setup);
        const ctx = new Context();
        const startTime = performance.now();
        res.on("finish", () => {
            logger.http(req.method, req.path, res.statusCode, performance.now() - startTime);
        })
        await handler(ctx);
        res.end();
    }
}


export class BoringApi {
    async scan(path: string) {
        const app = express();

        const tree = this.scanDir(path);

        const setupHandlers = getFilesOfType(tree, FileType.setup)
        const setup = new Setup();

        for (const setupHandler of setupHandlers) {
            await setupHandler.file.meta.setup(setup);
        }

        setup.mergeWithDefault();

        const handlers = getFilesOfType(tree, FileType.handler);
        handlers.forEach( handler => {
            let path = this.getNodePath(handler);
            console.log("path: ", path);
            // @ts-ignore
            app[handler.name](path, createExpressHandler(setup, handler.file.meta.handler));
        });
        console.log("start listening")

        app.listen(4040);
    }

    private scanDir(dir: string, parent?: Node, depth?: number): Node[] {
        const tree: Node[] = [];
        const files = readdirSync(dir, { withFileTypes: true });

        for (const file of files) {
            let node: Node;

            if (file.isDirectory()) {
                node = {
                    parent,
                    nodes: [],
                    name: basename(file.name, ".ts"),
                    path: `${dir}/${file.name}`,
                    file: { type: FileType.folder },
                    depth: depth ?? 0,
                };
                node.nodes = this.scanDir(`${dir}/${file.name}`, node, 1 + (depth ?? 0));
            } else {
                node = {
                    parent,
                    nodes: [],
                    name: basename(file.name, ".ts"),
                    path: `${dir}/${file.name}`,
                    file: this.getFileData(`${dir}/${file.name}`, parent),
                    depth: depth ?? 0,
                };
            }
            tree.push(node);
        }

        return tree;
    }

    private getFileData(file: string, parent?: Node): File {
        if (parent && parent.name === "_setup") {
            return {
                type: FileType.setup,
                meta: {
                    ...require(file),
                }
            }
        }

        const fileName = basename(file, ".ts")

        if([
            "get", "post", "delete", "patch", "options", "head"
        ].includes(fileName)) {
            const data = require(file)
            return {
                type: FileType.handler,
                meta: {
                    ...data,
                }
            }
        }


        if(/^\[[a-zA-Z]+\\]$/.test(fileName)) {
            const data = require(file)
            return {
                type: FileType.handler,
                meta: {
                    ...data,
                }
            }
        }



        switch(basename(file, ".ts")) {
            case "get":
            case "post":
            case "delete":
            case "patch":
            case "options":
            case "head":

            default:
                console.info(`Unsupported file type '${basename(file)}'`);
                return {
                    type: FileType.unknown,
                }
        }
    }

    private getNodePath(node: Node) {
        let paths: string[] = [];
        let currentNode: Node | undefined = node;

        do {
            if (currentNode) {
                paths.push(currentNode.name);
                currentNode = currentNode.parent;
            }
        } while (currentNode?.name);

        return `/${paths.reverse().join("/")}`;
    }
}

const test = new BoringApi();
test.scan(normalize(join(process.cwd(), "src", "endpoints")));
