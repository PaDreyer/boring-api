import { OperationsRuntime, OperationalAttributes } from "./operations";

export class Logger {
    constructor(private readonly operations: OperationsRuntime) {}

    http(method: string, route: string, code: number, duration: number, correlationId?: string) {
        if (!this.operations.log("info", "http.completed", "HTTP request completed", correlationId,
            { method: method.toUpperCase(), route, statusCode: code, durationMs: Number(duration.toFixed(3)) })) {
            console.info(`[${method.toUpperCase()}] ${route} - ${code} ${duration.toFixed(1)}ms`);
        }
    }

    info(msg: string, event = "application.info", correlationId?: string, attributes: OperationalAttributes = {}) {
        if (!this.operations.log("info", event, msg, correlationId, attributes)) console.info(msg);
    }

    error(error: unknown, event = "application.error", correlationId?: string, attributes: OperationalAttributes = {}) {
        if (!this.operations.log("error", event, "Application operation failed", correlationId, attributes)) {
            console.error("Application operation failed", { event, ...(correlationId ? { correlationId } : {}), attributes });
        }
    }
}
