export { BoringApi } from "./core";
export { Context } from "./core/context";
export { SetupContext } from "./core/setupContext";
export { HttpError, ApplicationError } from "./core/errors";
export { requirePermissions } from "./core/permissions";
export type { PermissionRule } from "./core/permissions";
export type {
    RouteModule, Handler, MiddlewareHook, AuthenticationHook, AuthorizationHook,
    EnvelopeHook, ErrorHook, AuthModule,
} from "./core/types";

export type { ApplicationErrorCode } from "./core/errors";
export type { ExecutionContext, ExecutionIdentity, ExecutionOptions } from "./core/execution";
export { ExecutionError } from "./core/execution";
export { LifecycleError, ShutdownTimeoutError } from "./core/lifecycle";
export type { Application, ApplicationOptions, ExecutionScope } from "./core/lifecycle";
