import { postgresTriggers } from "./triggers";
export { triggerMigration } from "./triggers";
import type { TriggerAdapter, JobAdapter, JobClaim, JobFailure, StoredJob } from "@boringapi/core";

/** The narrow pg-compatible capability we borrow; public declarations need no driver types. */
export interface PostgresConnection {
    query(text: string, values?: any[]): Promise<{ rows: any[]; rowCount: number | null }>;
    release(discard?: boolean): void;
}
export interface PostgresPool {
    query(text: string, values?: any[]): Promise<{ rows: any[]; rowCount: number | null }>;
    connect(): Promise<PostgresConnection>;
}

/** Append to the application's explicit migration history. Never run at startup. */
export const jobMigration = {
    name: "boring_jobs_v1",
    sql: `
CREATE TABLE boring_jobs (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    version integer NOT NULL CHECK (version > 0),
    payload jsonb NOT NULL,
    origin jsonb NOT NULL,
    policy jsonb NOT NULL,
    max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 100),
    attempt integer NOT NULL DEFAULT 0,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
    available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    lease_token uuid,
    lease_until timestamptz,
    last_error jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    finished_at timestamptz
);
CREATE INDEX boring_jobs_available ON boring_jobs (available_at, created_at) WHERE status = 'pending';
CREATE INDEX boring_jobs_expired ON boring_jobs (lease_until) WHERE status = 'running';
CREATE INDEX boring_jobs_failed ON boring_jobs (finished_at) WHERE status = 'failed';
`,
} as const;

export interface JobRecord extends StoredJob {
    readonly attempt: number;
    readonly status: "pending" | "running" | "succeeded" | "failed";
    readonly lastError: JobFailure | null;
}
function stored(row: any): StoredJob {
    return { id: row.id, name: row.name, version: row.version, payload: row.payload, origin: row.origin, policy: row.policy };
}
function record(row: any): JobRecord { return { ...stored(row), attempt: row.attempt, status: row.status, lastError: row.last_error }; }

// JSONB cannot represent NUL or lone UTF-16 surrogates. Diagnostic text must never
// turn a business failure into a queue I/O failure; preserve valid Unicode pairs.
function errorText(value: string): string { return value.replace(/[\u0000\uD800-\uDFFF]/gu, "\uFFFD"); }

// Materialization keeps the expiry predicate outside the locking read. A plain
// UPDATE WHERE can test time before waiting for a row lock and accept an expired lease.
const lockedClaim = `WITH locked AS MATERIALIZED (
    SELECT id, lease_token, status, lease_until FROM boring_jobs WHERE id = $1 FOR UPDATE
)`;

/** Borrows an application-owned pool. SQL uses the pool's configured search_path. */
export function createPostgresJobs(pool: PostgresPool): TriggerAdapter & {
    get(id: string): Promise<JobRecord | undefined>;
    failed(limit?: number): Promise<JobRecord[]>;
    retry(id: string): Promise<boolean>;
} {
    return {
        ...postgresTriggers(pool),
        async enqueue(job) {
            // A dedicated transaction overrides asynchronous commit for the durable receipt.
            const client = await pool.connect();
            let discard = false;
            try {
                await client.query("BEGIN");
                await client.query("SET LOCAL synchronous_commit = on");
                await client.query(`INSERT INTO boring_jobs (id, name, version, payload, origin, policy, max_attempts)
                    VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7)`,
                [job.id, job.name, job.version, JSON.stringify(job.payload), JSON.stringify(job.origin), JSON.stringify(job.policy), job.policy.maxAttempts]);
                await client.query("COMMIT");
            } catch (error) {
                try { await client.query("ROLLBACK"); } catch { discard = true; }
                throw error;
            } finally { client.release(discard); }
        },
        async claim(leaseMs, kind = "job") {
            const category = kind === "job" ? "name NOT LIKE '@%'" : kind === "event" ? "name LIKE '@event/%'" : kind === "schedule" ? "name LIKE '@schedule/%'" : undefined;
            if (!category) throw new TypeError("Unknown delivery kind");
            // Expired last attempts remain searchable failures, including after a process crash.
            await pool.query(`WITH expired AS (
                SELECT id FROM boring_jobs WHERE ${category} AND status = 'running' AND lease_until <= clock_timestamp()
                    AND attempt >= max_attempts FOR UPDATE SKIP LOCKED
            ) UPDATE boring_jobs j SET status = 'failed', lease_token = NULL, lease_until = NULL,
                finished_at = clock_timestamp(), last_error = '{"code":"attempts_exhausted","message":"Final attempt lease expired"}'::jsonb
                FROM expired e WHERE j.id = e.id`);
            const result = await pool.query(`WITH next AS (
                SELECT id FROM boring_jobs WHERE ${category} AND attempt < max_attempts AND
                    ((status = 'pending' AND available_at <= clock_timestamp()) OR (status = 'running' AND lease_until <= clock_timestamp()))
                ORDER BY available_at, created_at, id FOR UPDATE SKIP LOCKED LIMIT 1
            ) UPDATE boring_jobs j SET status = 'running', attempt = attempt + 1,
                lease_token = gen_random_uuid(), lease_until = clock_timestamp() + $1 * interval '1 millisecond'
                FROM next n WHERE j.id = n.id RETURNING j.*`, [leaseMs]);
            const row = result.rows[0];
            return row ? { ...stored(row), attempt: row.attempt, token: row.lease_token } : undefined;
        },
        async renew(claim, leaseMs) {
            const result = await pool.query(`${lockedClaim}
                UPDATE boring_jobs j SET lease_until = clock_timestamp() + $3 * interval '1 millisecond'
                FROM locked l WHERE j.id = l.id AND l.lease_token = $2 AND l.status = 'running'
                    AND l.lease_until > clock_timestamp()`, [claim.id, claim.token, leaseMs]);
            return result.rowCount === 1;
        },
        async succeed(claim) {
            const result = await pool.query(`${lockedClaim}
                UPDATE boring_jobs j SET status = 'succeeded', finished_at = clock_timestamp(),
                lease_token = NULL, lease_until = NULL, last_error = NULL
                FROM locked l WHERE j.id = l.id AND l.lease_token = $2 AND l.status = 'running'
                    AND l.lease_until > clock_timestamp()`, [claim.id, claim.token]);
            return result.rowCount === 1;
        },
        async fail(claim, error, retryInMs) {
            const retry = retryInMs !== undefined && claim.attempt < claim.policy.maxAttempts;
            const result = await pool.query(`${lockedClaim}
                UPDATE boring_jobs j SET status = $3,
                available_at = clock_timestamp() + $4 * interval '1 millisecond',
                finished_at = CASE WHEN $3 = 'failed' THEN clock_timestamp() ELSE NULL END,
                lease_token = NULL, lease_until = NULL, last_error = $5::jsonb
                FROM locked l WHERE j.id = l.id AND l.lease_token = $2 AND l.status = 'running'
                    AND l.lease_until > clock_timestamp()`,
            [claim.id, claim.token, retry ? "pending" : "failed", retry ? retryInMs : 0,
                JSON.stringify({ code: errorText(error.code), message: errorText(error.message) })]);
            return result.rowCount === 1;
        },
        async get(id) {
            const result = await pool.query("SELECT * FROM boring_jobs WHERE id = $1", [id]);
            return result.rows[0] ? record(result.rows[0]) : undefined;
        },
        async failed(limit = 100) {
            if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RangeError("Failed job limit must be between 1 and 1000");
            const result = await pool.query("SELECT * FROM boring_jobs WHERE status = 'failed' ORDER BY finished_at, id LIMIT $1", [limit]);
            return result.rows.map(record);
        },
        async retry(id) {
            // Explicit operator action preserves payload/version/origin and resets the attempt budget.
            const result = await pool.query(`UPDATE boring_jobs SET status = 'pending', attempt = 0, available_at = clock_timestamp(),
                finished_at = NULL, lease_token = NULL, lease_until = NULL WHERE id = $1 AND status = 'failed'`, [id]);
            return result.rowCount === 1;
        },
    };
}
