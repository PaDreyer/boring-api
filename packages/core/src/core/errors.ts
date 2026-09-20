import { STATUS_CODES } from "http";
import { ExecutionError } from "./execution";

export type ApplicationErrorCode = "forbidden" | "not_found" | "conflict" | "invalid_input";
/** Stable business category; no transport status or request dependency. */
export class ApplicationError extends Error {
    constructor(public readonly code: ApplicationErrorCode, message: string, public readonly details?: unknown) {
        super(message);
        if (!["forbidden", "not_found", "conflict", "invalid_input"].includes(code)) throw new TypeError("Unknown application error code");
        this.name = "ApplicationError";
    }
}


export class HttpError extends Error {
    constructor(
        public readonly status: number,
        message: string,
        public readonly details?: unknown,
    ) {
        super(message);
        if (!Number.isInteger(status) || status < 400 || status > 599) {
            throw new RangeError("HTTP error status must be between 400 and 599");
        }
        this.name = "HttpError";
    }
}

export function asHttpError(error: unknown): HttpError {
    if (error instanceof HttpError) return error;
    if (error instanceof ApplicationError) return new HttpError(({ forbidden: 403, not_found: 404, conflict: 409, invalid_input: 400 })[error.code], error.message, error.details);
    if (error instanceof ExecutionError) return new HttpError(error.code === "deadline" ? 504 : 503, error.message);

    // express.json() and other Express middleware may attach an HTTP status.
    if (error && typeof error === "object" && "status" in error) {
        const status = (error as { status?: unknown }).status;
        if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status < 500) {
            return new HttpError(status, status === 400 ? "Invalid JSON body" : STATUS_CODES[status] ?? "Bad Request");
        }
    }

    return new HttpError(500, "Internal Server Error");
}
