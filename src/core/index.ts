import express, { Express, NextFunction, Request, Response } from "express";
import { Server } from "http";
import { ZodTypeAny } from "zod";
import { Context } from "./context";
import { discover } from "./discovery";
import { asHttpError, HttpError } from "./errors";
import { SetupContext } from "./setupContext";
import { AuthModule, ErrorModule, Route, RouteScope } from "./types";

function parseInput(schema: ZodTypeAny | undefined, value: unknown, field: string): unknown {
    if (!schema) return value;
    try {
        return schema.parse(value);
    } catch (error) {
        const details = error && typeof error === "object" && "issues" in error
            ? (error as { issues: unknown }).issues : undefined;
        throw new HttpError(400, `Invalid ${field}`, details);
    }
}

function findErrorTemplate(scope: RouteScope, status: number): ErrorModule | undefined {
    for (let i = scope.errors.length - 1; i >= 0; i--) {
        const layer = scope.errors[i];
        const template = layer.statuses.get(status) ??
            (status >= 500 ? layer.statuses.get(500) : undefined) ?? layer.generic;
        if (template) return template;
    }
    return undefined;
}

function registerRoute(app: Express, route: Route, auth: AuthModule | undefined, setup: SetupContext) {
    const { module: mod } = route;
    const run = async (req: Request, res: Response, next: NextFunction) => {
        const ctx = new Context(req, res, setup);
        res.locals.boringContext = ctx;
        res.locals.boringScope = route.scope;
        try {
            if (auth?.authenticate) {
                const session = await auth.authenticate(ctx);
                if (session !== undefined) ctx.set("session", session);
            }
            for (const middleware of route.scope.middleware) {
                ctx.assignLocals(await middleware.handler(ctx));
                if (res.headersSent) return;
            }

            if ((mod.authentication === true || mod.authorization !== undefined) &&
                (ctx.session === undefined || ctx.session === null)) {
                throw new HttpError(401, "Unauthorized");
            }
            if (mod.authorization !== undefined) {
                if (!auth?.authorize) throw new HttpError(403, "Forbidden");
                await auth.authorize(ctx, mod.authorization);
            }

            ctx.set("params", parseInput(mod.params, req.params, "params"));
            ctx.set("query", parseInput(mod.query, req.query, "query"));
            ctx.set("body", parseInput(mod.body, req.body, "body"));

            const returned = await mod.handler(ctx);
            if (res.headersSent) return;
            if (returned !== undefined) ctx.payload = returned;

            if (!ctx.has("response_payload") && !mod.output) {
                res.status(204).end();
                return;
            }

            if (mod.output) ctx.payload = mod.output.parse(ctx.payload);
            if (route.scope.envelope && mod.envelope !== false) {
                const wrapped = await route.scope.envelope.handler(ctx);
                if (wrapped !== undefined) ctx.payload = wrapped;
            }
            if (!res.headersSent) res.send(ctx.payload);
        } catch (error) {
            next(error);
        }
    };
    (app as unknown as Record<string, (path: string, handler: typeof run) => void>)[route.method](route.path, run);
}

export class BoringApi {
    async createApp(apiDirectory: string): Promise<Express> {
        const { routes, setup: setupModule, auth, rootScope } = discover(apiDirectory);
        const setup = new SetupContext();
        if (setupModule) setup.assign(await setupModule.setup(setup));

        const app = express();
        app.disable("x-powered-by");
        app.use((req, res, next) => {
            const start = performance.now();
            res.once("finish", () => setup.logger.http(req.method, req.path, res.statusCode, performance.now() - start));
            next();
        });
        app.use(express.json());

        for (const route of routes) registerRoute(app, route, auth, setup);

        app.use((_req, _res, next) => next(new HttpError(404, "Not Found")));
        app.use(async (error: unknown, req: Request, res: Response, _next: NextFunction) => {
            if (res.headersSent) return _next(error);
            const httpError = asHttpError(error);
            if (httpError.status >= 500) setup.logger.error(error);
            res.status(httpError.status);

            const scope = (res.locals.boringScope as RouteScope | undefined) ?? rootScope;
            const hook = findErrorTemplate(scope, httpError.status);
            if (hook) {
                const ctx = (res.locals.boringContext as Context | undefined) ?? new Context(req, res, setup);
                const cause = error instanceof Error ? error : new Error(String(error));
                ctx.delete("response_payload");
                ctx.set("error", cause);
                try {
                    const returned = await hook.handler(ctx, cause);
                    if (res.headersSent) return;
                    if (returned !== undefined) ctx.payload = returned;
                    if (ctx.has("response_payload")) {
                        res.send(ctx.payload);
                        return;
                    }
                } catch (hookError) {
                    setup.logger.error(hookError);
                    res.status(500);
                }
            }

            const status = res.statusCode;
            res.json({ error: { message: status >= 500 ? "Internal Server Error" : httpError.message,
                ...(status < 500 && httpError.details !== undefined ? { details: httpError.details } : {}) } });
        });
        return app;
    }

    /** Starts the API and returns the HTTP server for clean shutdown. */
    async listen(apiDirectory: string, port = 4040): Promise<Server> {
        const app = await this.createApp(apiDirectory);
        return new Promise<Server>((resolve, reject) => {
            const server = app.listen(port, () => {
                const address = server.address();
                console.info(`Listening on port ${typeof address === "object" && address ? address.port : port}`);
                resolve(server);
            });
            server.once("error", reject);
        });
    }
}
