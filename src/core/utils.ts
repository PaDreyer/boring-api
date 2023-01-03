import {Logger} from "./logger";
import {SetupContext} from "./setupContext";
import {Context} from "./context";
import {NextFunction, Request, Response} from "express";
import {ApiFileType, FileNode} from "./node";

/**
 * Get logger from setup context
 * @param setupCtx
 */
export function getLogger(setupCtx: SetupContext): Logger {
    if (!setupCtx.has("logger")) throw new Error("Missing Logger");

    return setupCtx.get("logger");
}

/**
 * Filter FileNodes for given argument
 * @param nodes
 * @param type
 */
export function getFilesOfType(nodes: FileNode[], type: ApiFileType) {
    const handler: FileNode[] = [];

    for (const node of nodes) {
        if (node.file.type === type) {
            handler.push(node);
        } else if (node.file.type === ApiFileType.folder) {
            handler.push(...getFilesOfType(node.nodes, type));
        }
    }

    return handler;
}

/**
 * Create a normal api handler for express
 * @param setupCtx
 * @param handler
 */
export function createExpressHandler(setupCtx: SetupContext, handler: (ctx: Context) => Promise<unknown>) {
    return async (req: Request, res: Response, next: NextFunction) => {
        return expressWrapper(setupCtx, req, res, handler).catch(e => next(e));
    }
}

/**
 * Create an error handler for express for a given status code
 * @param setupCtx
 * @param statusCode
 * @param handler
 */
export function createExpressErrorHandler(setupCtx: SetupContext, handler: (ctx: Context) => Promise<unknown>) {
    return async (err: Error, req: Request, res: Response, next: NextFunction) => {
        return expressWrapper(setupCtx, req, res, handler, err).catch(e => next(e));
    }
}

/**
 * Create a basic express handler (wrapper)
 * @param setupCtx
 * @param req
 * @param res
 * @param handler
 * @param error
 */
async function expressWrapper(setupCtx: SetupContext, req: Request, res: Response, handler: (ctx: Context, error?: Error) => Promise<unknown>, error?: Error) {
    const logger = getLogger(setupCtx);
    const ctx = new Context(req, res);
    const startTime = performance.now();
    res.on("finish", () => {
        logger.http(req.method, req.path, res.statusCode, performance.now() - startTime);
    })

    await handler(ctx, error);
}

export function filterErrorHandlerNodes(nodes: FileNode[]): FileNode[] {
    const baseNodes = getFilesOfType(nodes, ApiFileType.base);
    return baseNodes.filter(node => {
        const parsedCode = parseInt(node.file.name);
        if (isNaN(parsedCode)) {
            return false;
        }

        if (parsedCode >= 400 && parsedCode <= 520) {
            return true;
        }

        return false;
    })
}