import { Logger } from "./logger";

/** Shared across requests; use this for services, never for request state. */
export class SetupContext extends Map<string, unknown> {
    private readonly serviceValues: Record<string, unknown> = {};

    constructor() {
        super();
        this.set("logger", new Logger());
    }

    set(key: string, value: unknown): this {
        this.serviceValues[key] = value;
        return super.set(key, value);
    }

    assign(values: unknown): void {
        if (!values || typeof values !== "object" || Array.isArray(values)) return;
        for (const [key, value] of Object.entries(values as Record<string, unknown>)) this.set(key, value);
    }

    get services(): Readonly<Record<string, unknown>> {
        return this.serviceValues;
    }

    get logger(): Logger {
        return this.get("logger") as Logger;
    }
}
