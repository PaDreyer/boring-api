import { STATUS_CODES } from "http";

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

    // express.json() and other Express middleware may attach an HTTP status.
    if (error && typeof error === "object" && "status" in error) {
        const status = (error as { status?: unknown }).status;
        if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status < 500) {
            return new HttpError(status, status === 400 ? "Invalid JSON body" : STATUS_CODES[status] ?? "Bad Request");
        }
    }

    return new HttpError(500, "Internal Server Error");
}
