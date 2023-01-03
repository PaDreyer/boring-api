import {readdirSync} from "fs";
import {basename, extname, join, normalize} from 'path';
import express, {NextFunction, Request, Response} from 'express';
import {SetupContext} from "./setupContext";
import {
    createExpressErrorHandler,
    createExpressHandler,
    filterErrorHandlerNodes,
    getFilesOfType,
    getLogger
} from './utils';
import {ApiFile, ApiFileType, FileNode} from "./node";
import {Context} from "./context";


export class BoringApi {
    async scan(path: string) {
        const app = express();

        const tree = this.scanTree(path);

        const setupHandlers = getFilesOfType(tree, ApiFileType.setup)

        const setup = new SetupContext();
        for (const setupHandler of setupHandlers) {
            await setupHandler.file.meta.setup(setup);
        }

        setup.mergeWithDefault();


        app.use((req, res, next) => {
            const ctx =  new Context(req, res);
            ctx.set("setup", setup);
            ctx.set("headers", req.headers);
            ctx.set("query", req.query);
            ctx.set("params", req.params);
            req.app.locals.ctx = ctx;
            return next();
        })


        const authenticationMiddleware = getFilesOfType(tree, ApiFileType.base)
            .find( node => node.file.name === "authentication");

        if (authenticationMiddleware) {
            app.use(async (req, res, next) => {
                try {
                    await authenticationMiddleware.file.meta.handler(req.app.locals.ctx);
                } catch(e) {
                    return next(e);
                }

                return next();
            })
        }

        const authorizationHandler= getFilesOfType(tree, ApiFileType.base)
            .find( node => node.file.name === "authorization");

        const envelopeHandler = getFilesOfType(tree, ApiFileType.base)
            .find( node => node.file.name === "envelope");

        const handlers = getFilesOfType(tree, ApiFileType.handler);
        handlers.forEach( handler => {
            let path = this.getNodePath(handler);
            // @ts-ignore
            app[handler.file.name](path, (req: Request, res: Response, next: NextFunction) => {
                const ctx = req.app.locals.ctx;

                const setup = ctx.get("setup");
                const logger = getLogger(setup);
                const startTime = performance.now();
                res.on("finish", () => {
                    logger.http(req.method, req.path, res.statusCode, performance.now() - startTime);
                })

                if (!ctx.has("session") && (handler.file.meta.authentication === true || handler.file.meta.authorization !== undefined)) {
                    res.status(401);
                    return next(new Error("401"))
                }

                if (handler.file.meta.authorization !== undefined && authorizationHandler) {
                    try {
                        authorizationHandler.file.meta.handler(ctx, handler.file.meta.authorization);
                    } catch(e) {
                        res.status(403)
                        return next(e);
                    }
                }

                if (handler.file.meta.body !== undefined) {
                    try {
                        handler.file.meta.body.parse(ctx.get("body"))
                    } catch(e) {
                        res.status(400);
                        return next(e);
                    }
                }


                handler.file.meta.handler(ctx).catch((e: any) => next(e));

                if (handler.file.meta.envelope == true) {
                    envelopeHandler?.file.meta.handler(ctx).catch((e: any) => next(e));
                }

                ctx.send(ctx.payload)
            });
        });



        const errors = filterErrorHandlerNodes(tree);
        const notFoundNode = errors.find(node => node.file.name === "404");
        if (notFoundNode) {
            app.use(createExpressHandler(setup, notFoundNode.file.meta.handler));
        }

        const errorNode = errors.find(node => node.file.name === "500");
        if (errorNode) {
            app.use(createExpressErrorHandler(setup, errorNode.file.meta.handler))
        }

        const logger = getLogger(setup);
        logger.info("Start listening on port " + 4040);

        app.listen(4040);
    }

    private scanTree(dir: string, parent?: FileNode, depth?: number): FileNode[] {
        const tree: FileNode[] = [];
        const files = readdirSync(dir, { withFileTypes: true });

        for (const file of files) {
            let node: FileNode;

            if (file.isDirectory()) {
                node = {
                    parent,
                    nodes: [],
                    file: {
                        type: ApiFileType.folder,
                        name: basename(file.name, ".ts"),
                        extension: extname(file.name),
                        path: `${dir}/${file.name}`,
                    },
                    depth: depth ?? 0,
                };
                node.nodes = this.scanTree(`${dir}/${file.name}`, node, 1 + (depth ?? 0));
            } else {
                node = {
                    parent,
                    nodes: [],
                    file: this.getFileData(`${dir}/${file.name}`, basename(file.name, ".ts"), extname(file.name), parent),
                    depth: depth ?? 0,
                };
            }
            tree.push(node);
        }

        return tree;
    }

    private getFileData(file: string, name: string, extension: string, parent?: FileNode): ApiFile {
        if (parent && parent.file.name === "_setup") {
            return {
                type: ApiFileType.setup,
                path: file,
                name,
                extension,
                meta: {
                    ...require(file),
                }
            }
        }

        if (parent && parent.file.name === '_base') {
            const data = require(file)
            return {
                type: ApiFileType.base,
                path: file,
                name,
                extension,
                meta: {
                    ...data,
                }
            }
        }

        if([
            "get", "post", "delete", "patch", "options", "head"
        ].includes(name)) {
            const data = require(file)
            return {
                type: ApiFileType.handler,
                path: file,
                name,
                extension,
                meta: {
                    ...data,
                }
            }
        }

        if(name === "not_found") {
            const data = require(file);
            return {
                type: ApiFileType.notfound,
                path: file,
                name,
                extension,
                meta: {
                    ...data,
                }
            }
        }


        // TODO: remove
        if(/^\[[a-zA-Z]+\\]$/.test(name)) {
            const data = require(file)
            return {
                type: ApiFileType.handler,
                path: file,
                name,
                extension,
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
                    path: file,
                    name,
                    extension,
                    type: ApiFileType.unknown,
                }
        }
    }

    private getNodePath(node: FileNode) {
        let paths: string[] = [];
        let currentNode: FileNode | undefined = node;

        do {
            if (currentNode) {
                paths.push(currentNode.file.name);
                currentNode = currentNode.parent;
            }
        } while (currentNode?.file.name);

        paths = paths.reverse();
        paths.pop();
        return `/${paths.join("/")}`;
    }
}




const test = new BoringApi();
test.scan(normalize(join(process.cwd(), "src", "endpoints")));
