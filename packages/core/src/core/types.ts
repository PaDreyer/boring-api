import { ZodTypeAny } from "zod";
import { Context } from "./context";
import { SetupContext } from "./setupContext";

export type Handler = (context: Context) => unknown | Promise<unknown>;
export type MiddlewareHook = (context: Context) => unknown | Promise<unknown>;
export type AuthenticationHook = (context: Context) => unknown | Promise<unknown>;
export type AuthorizationHook = (context: Context, rule: unknown) => void | Promise<void>;
export type EnvelopeHook = (context: Context) => unknown | Promise<unknown>;
export type ErrorHook = (context: Context, error: Error) => unknown | Promise<unknown>;

export interface RouteModule {
    handler: Handler;
    params?: ZodTypeAny;
    query?: ZodTypeAny;
    body?: ZodTypeAny;
    output?: ZodTypeAny;
    authentication?: boolean;
    authorization?: unknown;
    envelope?: boolean;
}

export interface ConfigModule {
    schema: ZodTypeAny;
    load: (env: Readonly<Record<string, string | undefined>>) => unknown | Promise<unknown>;
}

export interface SetupModule {
    setup: (context: SetupContext) => unknown | Promise<unknown>;
}

export interface AuthModule {
    authenticate?: AuthenticationHook;
    authorize?: AuthorizationHook;
}

export interface MiddlewareModule {
    handler: MiddlewareHook;
}

export interface EnvelopeModule {
    handler: EnvelopeHook;
}

export interface ErrorModule {
    handler: ErrorHook;
}

export interface ErrorLayer {
    generic?: ErrorModule;
    statuses: Map<number, ErrorModule>;
}

export interface RouteScope {
    middleware: MiddlewareModule[];
    envelope?: EnvelopeModule;
    errors: ErrorLayer[];
}

export interface Route {
    method: string;
    path: string;
    source: string;
    module: RouteModule;
    scope: RouteScope;
}
