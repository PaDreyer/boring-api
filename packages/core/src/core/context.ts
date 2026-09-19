import { Request, Response } from "express";
import { SetupContext } from "./setupContext";

/** One context per request. Hooks and handlers may share values through the map. */
export class Context extends Map<string, unknown> {
    readonly locals: Record<string, unknown> = {};

    constructor(
        public readonly request: Request,
        public readonly response: Response,
        public readonly setup: SetupContext,
    ) {
        super();
        this.set("setup", setup);
        this.set("headers", request.headers);
        this.set("query", request.query);
        this.set("params", request.params);
        this.set("body", request.body);
    }

    get payload(): unknown {
        return this.get("response_payload");
    }

    set payload(value: unknown) {
        this.set("response_payload", value);
    }

    get statusCode(): number {
        return this.response.statusCode;
    }

    get params(): unknown {
        return this.get("params");
    }

    get query(): unknown {
        return this.get("query");
    }

    get body(): unknown {
        return this.get("body");
    }

    get session(): unknown {
        return this.get("session");
    }

    get services(): Readonly<Record<string, unknown>> {
        return this.setup.services;
    }

    assignLocals(values: unknown): void {
        if (!values || typeof values !== "object" || Array.isArray(values)) return;
        for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
            this.locals[key] = value;
            this.set(key, value);
        }
    }

    status(code: number): this {
        this.response.status(code);
        return this;
    }

    /** Sends immediately. Return a value from a handler to use output and envelope hooks. */
    send(value: unknown): Response {
        return this.response.send(value);
    }
}
