import { randomUUID } from "crypto";

export type OperationalValue = string | number | boolean | null;
export type OperationalAttributes = Readonly<Record<string, OperationalValue>>;
export type ExecutionKind = "http" | "controlled" | "job" | "schedule" | "event" | "command" | "publisher" | "event-ingress" | "scheduler";

export type OperationalRecord = {
    readonly kind: "log";
    readonly timestamp: number;
    readonly level: "info" | "error";
    readonly event: string;
    readonly message: string;
    readonly correlationId?: string;
    readonly attributes: OperationalAttributes;
} | {
    readonly kind: "span";
    readonly timestamp: number;
    readonly name: string;
    readonly traceId: string;
    readonly spanId: string;
    readonly links: readonly string[];
    readonly durationMs: number;
    readonly status: "ok" | "error" | "cancelled";
    readonly attributes: OperationalAttributes;
} | {
    readonly kind: "metric";
    readonly timestamp: number;
    readonly name: string;
    readonly metric: "counter" | "histogram";
    readonly value: number;
    readonly labels: Readonly<Record<string, string>>;
};

/** Emit must return promptly and must not retain application resources. Flush is awaited at shutdown. */
export interface OperationalAdapter {
    emit(record: OperationalRecord): void | Promise<void>;
    flush?(): void | Promise<void>;
}

export interface OperationalOptions {
    readonly bufferSize?: number;
    readonly flushTimeoutMs?: number;
}

export interface ReadinessProbeOptions { readonly timeoutMs?: number; }
export interface HealthReport {
    readonly status: "up" | "down";
    readonly state: "ready" | "draining" | "closed";
}
export interface ReadinessReport {
    readonly status: "ready" | "not_ready";
    readonly state: "ready" | "draining" | "closed";
    readonly checks: readonly { readonly name: string; readonly status: "up" | "down"; readonly error?: "failed" | "timeout" }[];
}
export type MetricSnapshot = {
    readonly name: string;
    readonly metric: "counter";
    readonly labels: Readonly<Record<string, string>>;
    readonly value: number;
} | {
    readonly name: string;
    readonly metric: "histogram";
    readonly labels: Readonly<Record<string, string>>;
    readonly count: number;
    readonly sum: number;
    readonly max: number;
};

type Counter = { name: string; labels: Readonly<Record<string, string>>; value: number };
type Histogram = Counter & { count: number; max: number };

function positive(value: number | undefined, fallback: number, name: string): number {
    const result = value ?? fallback;
    if (!Number.isInteger(result) || result < 1 || result > 2147483647) throw new RangeError(`${name} must be a positive integer`);
    return result;
}
function attributesSnapshot(attributes: OperationalAttributes): OperationalAttributes {
    if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) throw new TypeError("Operational attributes must be a record");
    if (Object.getOwnPropertySymbols(attributes).length) throw new TypeError("Operational attributes cannot contain symbol keys");
    const result: Record<string, OperationalValue> = {};
    for (const key of Object.keys(attributes)) {
        const descriptor = Object.getOwnPropertyDescriptor(attributes, key)!;
        if (!("value" in descriptor)) throw new TypeError(`Operational attribute ${key} must be a data property`);
        const value = descriptor.value;
        if (value !== null && !["string", "number", "boolean"].includes(typeof value) || typeof value === "number" && !Number.isFinite(value)) {
            throw new TypeError(`Operational attribute ${key} must be a finite primitive value or null`);
        }
        result[key] = value as OperationalValue;
    }
    return Object.freeze(result);
}
function labelKey(name: string, labels: Readonly<Record<string, string>>): string {
    return `${name}\u0000${Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("\u0000")}`;
}
class OperationalTimeoutError extends Error {
    constructor(message: string) { super(message); this.name = "OperationalTimeoutError"; }
}
/** Internal nominal carrier for the two distinct failures of a timed-out flush. */
export class OperationalFlushError extends Error {
    constructor(readonly errors: readonly unknown[]) { super("Operational flush failed after timeout"); this.name = "OperationalFlushError"; }
}
function errorName(error: unknown): string { return error instanceof Error ? error.name : "Error"; }
function timeout<T>(pending: Promise<T>, milliseconds: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new OperationalTimeoutError(message)), milliseconds);
        pending.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });
}

export interface OperationalFlush {
    /** Bounded observer used by close(). */
    readonly bounded: Promise<void>;
    /** Actual adapter settlement; resources must remain owned until this settles. */
    readonly settled: Promise<void>;
}

/** Internal lifecycle-owned operational state. Metric labels are framework enums, never invocation IDs. */
export class OperationsRuntime {
    private adapter?: OperationalAdapter;
    private bufferSize = 1000;
    private flushTimeoutMs = 1000;
    private readonly pending = new Set<Promise<void>>();
    private readonly counters = new Map<string, Counter>();
    private readonly histograms = new Map<string, Histogram>();
    private readonly probes: { name: string; timeoutMs: number; check: () => void | Promise<void>; inFlight?: Promise<void> }[] = [];
    private readonly pendingProbes = new Set<Promise<void>>();
    private dropped = 0;
    private flushing?: OperationalFlush;

    bind(adapter: OperationalAdapter, options: OperationalOptions = {}): void {
        if (this.adapter) throw new Error("Configure observability only once");
        if (!adapter || typeof adapter.emit !== "function" || adapter.flush !== undefined && typeof adapter.flush !== "function") {
            throw new TypeError("Observability requires emit(record) and optional flush()");
        }
        this.bufferSize = positive(options.bufferSize, 1000, "Operational buffer size");
        this.flushTimeoutMs = positive(options.flushTimeoutMs, 1000, "Operational flush timeout");
        this.adapter = adapter;
    }

    readiness(name: string, check: () => void | Promise<void>, options: ReadinessProbeOptions = {}): void {
        if (!name.trim() || this.probes.some(probe => probe.name === name)) throw new TypeError("Readiness probe names must be nonempty and unique");
        if (typeof check !== "function") throw new TypeError("Readiness probe requires a function");
        this.probes.push({ name, check, timeoutMs: positive(options.timeoutMs, 1000, "Readiness timeout") });
    }

    private runProbe(probe: { check: () => void | Promise<void>; inFlight?: Promise<void> }): Promise<void> {
        if (probe.inFlight) return probe.inFlight;
        const pending = Promise.resolve().then(probe.check);
        probe.inFlight = pending;
        this.pendingProbes.add(pending);
        const settled = () => {
            if (probe.inFlight === pending) probe.inFlight = undefined;
            this.pendingProbes.delete(pending);
        };
        void pending.then(settled, settled);
        return pending;
    }

    private emit(record: OperationalRecord): boolean {
        if (!this.adapter) return false;
        if (this.pending.size >= this.bufferSize) {
            this.dropped++;
            return true;
        }
        let pending: Promise<void>;
        try { pending = Promise.resolve(this.adapter.emit(record)); }
        catch (error) { this.dropped++; console.error("Operational adapter emit failed:", errorName(error)); return true; }
        this.pending.add(pending);
        void pending.then(() => this.pending.delete(pending), error => {
            this.pending.delete(pending);
            this.dropped++;
            console.error("Operational adapter emit failed:", errorName(error));
        });
        return true;
    }

    log(level: "info" | "error", event: string, message: string, correlationId?: string, attributes: OperationalAttributes = {}): boolean {
        return this.emit({ kind: "log", timestamp: Date.now(), level, event, message, ...(correlationId ? { correlationId } : {}),
            attributes: attributesSnapshot(attributes) });
    }

    counter(name: string, labels: Readonly<Record<string, string>>, value = 1): void {
        const key = labelKey(name, labels);
        const point = this.counters.get(key) ?? { name, labels: Object.freeze({ ...labels }), value: 0 };
        point.value += value;
        this.counters.set(key, point);
        this.emit({ kind: "metric", timestamp: Date.now(), name, metric: "counter", value, labels: point.labels });
    }

    histogram(name: string, labels: Readonly<Record<string, string>>, value: number): void {
        const key = labelKey(name, labels);
        const point = this.histograms.get(key) ?? { name, labels: Object.freeze({ ...labels }), value: 0, count: 0, max: 0 };
        point.value += value;
        point.count++;
        point.max = Math.max(point.max, value);
        this.histograms.set(key, point);
        this.emit({ kind: "metric", timestamp: Date.now(), name, metric: "histogram", value, labels: point.labels });
    }

    startSpan(name: string, traceId: string, links: readonly string[] = [], attributes: OperationalAttributes = {}) {
        const started = performance.now();
        const timestamp = Date.now();
        const spanId = randomUUID();
        const spanLinks = Object.freeze([...new Set(links)]);
        const spanAttributes = attributesSnapshot(attributes);
        let ended = false;
        return (status: "ok" | "error" | "cancelled", extra: OperationalAttributes = {}) => {
            if (ended) return;
            ended = true;
            this.emit({ kind: "span", timestamp, name, traceId, spanId, links: spanLinks,
                durationMs: performance.now() - started, status, attributes: attributesSnapshot({ ...spanAttributes, ...extra }) });
        };
    }

    executionStarted(kind: ExecutionKind, correlationId: string, links: readonly string[] = [], attributes: OperationalAttributes = {}) {
        this.counter("boring_executions_total", { kind });
        const started = performance.now();
        const endSpan = this.startSpan(`boring.${kind}`, correlationId, links, attributes);
        return (status: "ok" | "error" | "cancelled") => {
            const duration = performance.now() - started;
            this.counter("boring_execution_results_total", { kind, status });
            this.histogram("boring_execution_duration_ms", { kind, status }, duration);
            if (kind !== "http") this.log(status === "error" ? "error" : "info", "execution.completed", "Framework execution completed", correlationId,
                { ...attributes, kind, status, durationMs: Number(duration.toFixed(3)) });
            endSpan(status);
        };
    }

    health(state: "ready" | "draining" | "closed"): HealthReport {
        return Object.freeze({ status: state === "closed" ? "down" : "up", state });
    }

    async readinessReport(readState: () => "ready" | "draining" | "closed"): Promise<ReadinessReport> {
        const initial = readState();
        if (initial !== "ready") return Object.freeze({ status: "not_ready", state: initial, checks: Object.freeze([]) });
        const checks = await Promise.all(this.probes.map(async probe => {
            const pending = this.runProbe(probe);
            try {
                await timeout(pending, probe.timeoutMs, `Timed out after ${probe.timeoutMs}ms`);
                return Object.freeze({ name: probe.name, status: "up" as const });
            } catch (error) {
                const reason = error instanceof OperationalTimeoutError ? "timeout" : "failed";
                this.log("error", "readiness.failed", "Readiness probe failed", undefined, { probe: probe.name, reason });
                return Object.freeze({ name: probe.name, status: "down" as const, error: reason });
            }
        }));
        const state = readState();
        return Object.freeze({ status: state === "ready" && checks.every(check => check.status === "up") ? "ready" : "not_ready", state, checks: Object.freeze(checks) });
    }

    metrics(): readonly MetricSnapshot[] {
        const result: MetricSnapshot[] = [
            ...[...this.counters.values()].map(point => Object.freeze({ name: point.name, metric: "counter" as const, labels: point.labels, value: point.value })),
            ...[...this.histograms.values()].map(point => Object.freeze({ name: point.name, metric: "histogram" as const, labels: point.labels,
                count: point.count, sum: point.value, max: point.max })),
        ];
        if (this.dropped) result.push(Object.freeze({ name: "boring_operational_records_dropped_total", metric: "counter", labels: Object.freeze({}), value: this.dropped }));
        return Object.freeze(result.sort((a, b) => labelKey(a.name, a.labels).localeCompare(labelKey(b.name, b.labels))));
    }

    flush(): OperationalFlush {
        if (this.flushing) return this.flushing;
        let timeoutFailure: unknown;
        const actual = (async () => {
            await Promise.allSettled([...this.pendingProbes]);
            if (!this.adapter) return;
            await Promise.allSettled([...this.pending]);
            await this.adapter.flush?.();
        })();
        const bounded = timeout(actual, this.flushTimeoutMs, `Operational flush timed out after ${this.flushTimeoutMs}ms`)
            .catch(error => { if (error instanceof OperationalTimeoutError) timeoutFailure = error; throw error; });
        const settled = actual.then(
            () => { if (timeoutFailure) throw timeoutFailure; },
            error => { throw timeoutFailure ? new OperationalFlushError([timeoutFailure, error]) : error; },
        );
        // Both branches are intentionally observed here; lifecycle consumers still
        // receive their original rejection without a transient unhandled rejection.
        void bounded.catch(() => {});
        void settled.catch(() => {});
        return this.flushing = Object.freeze({ bounded, settled });
    }
}
