import express, { Express, NextFunction, Request, Response } from "express";
import { ZodTypeAny } from "zod";
import { Application, ApplicationOptions, ApplicationRuntime, LifecycleError } from "./lifecycle";
import { Execution, ExecutionError, ExecutionIdentity, snapshot } from "./execution";
import { Context } from "./context";
import { discover } from "./discovery";
import { findErrorTemplate } from "./conventions";
import { asHttpError, HttpError } from "./errors";
import { SetupContext, setupLifecycle } from "./setupContext";
import { AuthModule, Route, RouteScope } from "./types";

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

type RequestState = { ctx: Context; execution: Execution; finish: () => void };

function registerRoute(app: Express, route: Route, auth: AuthModule | undefined, handleError: (error: unknown, req: Request, res: Response) => Promise<void>) {
    const { module: mod } = route;
    const run = async (req: Request, res: Response, next: NextFunction) => {
        const { ctx, execution, finish } = res.locals.boringState as RequestState;
        res.locals.boringScope = route.scope;
        try {
            ctx.set("body", req.body);
            ctx.set("params", req.params);
            ctx.execution.throwIfAborted();
            if (auth?.authenticate) {
                const session = await auth.authenticate(ctx);
                if (session !== undefined) ctx.set("session", session);
            }
            const session = ctx.session as (ExecutionIdentity & { tenantId?: string }) | undefined;
            execution.authenticate(session, session?.tenantId);
            if (session !== undefined) ctx.set("session", execution.context.identity);
            ctx.execution.throwIfAborted();
            for (const middleware of route.scope.middleware) {
                ctx.assignLocals(await middleware.handler(ctx));
                ctx.execution.throwIfAborted();
                if (res.headersSent) return;
            }

            if ((mod.authentication === true || mod.authorization !== undefined) &&
                (ctx.session === undefined || ctx.session === null)) {
                throw new HttpError(401, "Unauthorized");
            }
            if (mod.authorization !== undefined) {
                if (!auth?.authorize) throw new HttpError(403, "Forbidden");
                await auth.authorize(ctx, mod.authorization);
                ctx.execution.throwIfAborted();
            }

            ctx.set("params", parseInput(mod.params, req.params, "params"));
            ctx.set("query", parseInput(mod.query, req.query, "query"));
            ctx.set("body", parseInput(mod.body, req.body, "body"));

            const returned = await mod.handler(ctx);
            ctx.execution.throwIfAborted();
            if (res.headersSent) return;
            if (returned !== undefined) ctx.payload = returned;

            if (!ctx.has("response_payload") && !mod.output) {
                res.status(204).end();
                return;
            }

            if (mod.output) ctx.payload = mod.output.parse(ctx.payload);
            if (route.scope.envelope && mod.envelope !== false) {
                const wrapped = await route.scope.envelope.handler(ctx);
                ctx.execution.throwIfAborted();
                if (wrapped !== undefined) ctx.payload = wrapped;
            }
            if (!res.headersSent) res.send(ctx.payload);
        } catch (error) {
            await handleError(error, req, res);
        } finally { finish(); }
    };
    (app as unknown as Record<string, (path: string, handler: typeof run) => void>)[route.method](route.path, run);
}

export class BoringApi {
    async createApp<Services extends object = Record<string, unknown>>(apiDirectory: string, options: ApplicationOptions = {}): Promise<Application<Services>> {
        const { routes, jobs, config, setup: setupModule, auth, rootScope } = discover(apiDirectory);
        const environment = options.env ?? process.env;
        // Node's native environment is an exotic object, whether supplied explicitly or by default.
        const configuration = config ? snapshot(await config.schema.parseAsync(await config.load(snapshot(environment === process.env ? { ...environment } : environment)))) : {};
        const setup = new SetupContext(configuration, jobs);
        const app = express();
        const application = new ApplicationRuntime<Services>(app, setup, options);
        try {
            if (setupModule) setup.assign(await setupModule.setup(setup));
            setupLifecycle(setup).seal();
        } catch (error) {
            try { await setupLifecycle(setup).dispose(); } catch (cleanup) { throw new LifecycleError("Application startup and cleanup failed", [error, cleanup]); }
            throw error;
        }

        const handleError = async (error: unknown, req: Request, res: Response): Promise<void> => {
            if (res.headersSent || res.destroyed) return;
            const httpError = asHttpError(error);
            if (httpError.status >= 500) setup.logger.error(error);
            res.status(httpError.status);
            const scope = (res.locals.boringScope as RouteScope | undefined) ?? rootScope;
            const hook = findErrorTemplate(scope.errors, httpError.status);
            if (hook) {
                const ctx = (res.locals.boringState as RequestState).ctx;
                const cause = error instanceof Error ? error : new Error(String(error));
                ctx.delete("response_payload");
                ctx.set("error", cause);
                try {
                    const returned = await hook.handler(ctx, cause);
                    if (res.headersSent || res.destroyed) return;
                    if (returned !== undefined) ctx.payload = returned;
                    if (ctx.has("response_payload")) { res.send(ctx.payload); return; }
                } catch (hookError) {
                    setup.logger.error(hookError);
                    res.status(500);
                }
            }
            const status = res.statusCode;
            res.json({ error: { message: status >= 500 ? "Internal Server Error" : httpError.message,
                ...(status < 500 && httpError.details !== undefined ? { details: httpError.details } : {}) } });
        };
        app.disable("x-powered-by");
        app.use((req, res, next) => {
            let execution: Execution;
            try { execution = application.begin(); }
            catch (error) { res.status(503).json({ error: { message: "Application is not accepting requests" } }); return; }
            const start = performance.now();
            const ctx = new Context(req, res, setup, execution.context);
            const cancelInput = () => { if (!req.complete) req.destroy(); };
            execution.context.signal.addEventListener("abort", cancelInput, { once: true });
            let handled = false;
            let finished = false;
            const settle = () => {
                if (finished || !handled || !(res.writableFinished || res.destroyed)) return;
                finished = true;
                res.off("close", disconnected);
                res.off("finish", settle);
                execution.context.signal.removeEventListener("abort", cancelInput);
                application.finish(execution);
            };
            const disconnected = () => {
                if (!res.writableFinished) execution.abort(new ExecutionError("cancelled", "HTTP client disconnected"));
                settle();
            };
            res.once("close", disconnected);
            res.once("finish", settle);
            res.locals.boringState = { ctx, execution, finish() { handled = true; settle(); } } satisfies RequestState;
            res.once("finish", () => setup.logger.http(req.method, req.path, res.statusCode, performance.now() - start));
            next();
        });
        app.use(express.json());
        for (const route of routes) registerRoute(app, route, auth, handleError);
        app.use((_req, _res, next) => next(new HttpError(404, "Not Found")));
        app.use(async (error: unknown, req: Request, res: Response, _next: NextFunction) => {
            try { await handleError(error, req, res); }
            finally { (res.locals.boringState as RequestState).finish(); }
        });
        return application;
    }

    /** Starts an owned listener; the returned application owns shutdown. */
    async listen<Services extends object = Record<string, unknown>>(apiDirectory: string, port = 4040, options: ApplicationOptions = {}): Promise<Application<Services>> {
        const application = await this.createApp<Services>(apiDirectory, options);
        const server = await application.listen(port);
        const address = server.address();
        console.info(`Listening on port ${typeof address === "object" && address ? address.port : port}`);
        return application;
    }
}
