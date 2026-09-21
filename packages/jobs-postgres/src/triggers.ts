import { scheduleDue, triggerId, TriggerError } from "@boringapi/core";
import type { AcceptedEvent, EventReceipt, ScheduleOccurrence, ScheduleRegistration, StoredJob } from "@boringapi/core";
import type { PostgresConnection, PostgresPool } from "./index";

/** Append after jobMigration. Existing queue schemas/rows are preserved. */
export const triggerMigration = {
    name: "boring_triggers_v1",
    sql: `
CREATE TABLE boring_schedule_cursors (
    name text PRIMARY KEY,
    version integer NOT NULL,
    definition jsonb NOT NULL,
    scheduled_at bigint
);
CREATE TABLE boring_events (
    tenant text NOT NULL,
    type text NOT NULL,
    id uuid NOT NULL,
    version integer NOT NULL,
    payload jsonb NOT NULL,
    origin jsonb NOT NULL,
    deliveries jsonb NOT NULL,
    accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant, type, id)
);
`,
} as const;

async function transaction<T>(pool: PostgresPool, action: (client: PostgresConnection) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    let discard = false;
    try {
        await client.query("BEGIN");
        await client.query("SET LOCAL synchronous_commit = on");
        const result = await action(client);
        await client.query("COMMIT");
        return result;
    } catch (error) {
        try { await client.query("ROLLBACK"); } catch { discard = true; }
        throw error;
    } finally { client.release(discard); }
}
async function insert(client: PostgresConnection, job: StoredJob): Promise<void> {
    await client.query(`INSERT INTO boring_jobs (id, name, version, payload, origin, policy, max_attempts)
        VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7)`,
    [job.id, job.name, job.version, JSON.stringify(job.payload), JSON.stringify(job.origin), JSON.stringify(job.policy), job.policy.maxAttempts]);
}
export function postgresTriggers(pool: PostgresPool) {
    return {
        async acceptEvent(event: AcceptedEvent, jobs: readonly StoredJob[]): Promise<EventReceipt> {
            return transaction(pool, async client => {
                const tenant = event.origin.tenantId ?? "";
                const deliveries = jobs.map(job => job.id);
                const inserted = await client.query(`INSERT INTO boring_events (tenant, type, id, version, payload, origin, deliveries)
                    VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb)
                    ON CONFLICT (tenant, type, id) DO NOTHING RETURNING id`,
                [tenant, event.type, event.id, event.version, JSON.stringify(event.payload), JSON.stringify(event.origin), JSON.stringify(deliveries)]);
                if (inserted.rowCount) {
                    for (const job of jobs) await insert(client, job);
                    return { id: event.id, deliveries };
                }
                // The unique-key conflict waits for competing ingress to commit/roll back.
                // Compare JSONB, not serialization/property order; retain original correlation.
                const existing = await client.query(`SELECT deliveries, (version = $4 AND payload = $5::jsonb AND origin->'identity' = $6::jsonb) AS same
                    FROM boring_events WHERE tenant = $1 AND type = $2 AND id = $3`,
                [tenant, event.type, event.id, event.version, JSON.stringify(event.payload), JSON.stringify(event.origin.identity)]);
                if (!existing.rows[0]?.same) throw new TriggerError("event_conflict", "Event identity already accepted with different content or producer");
                return { id: event.id, deliveries: existing.rows[0].deliveries };
            });
        },
        async schedule(registration: ScheduleRegistration): Promise<readonly ScheduleOccurrence[]> {
            return transaction(pool, async client => {
                const { name, version, timing, input, policy, origin } = registration;
                // Configuration changes require a monotone revision. Old processes cannot
                // roll the cursor back during a rolling deployment.
                const definition = JSON.stringify({ timing, input, policy, identity: origin.identity, tenant: origin.tenantId ?? null });
                await client.query(`INSERT INTO boring_schedule_cursors (name, version, definition) VALUES ($1, $2, $3::jsonb) ON CONFLICT (name) DO NOTHING`, [name, version, definition]);
                const locked = await client.query(`SELECT version, scheduled_at, definition = $2::jsonb AS same FROM boring_schedule_cursors WHERE name = $1 FOR UPDATE`, [name, definition]);
                const row = locked.rows[0];
                if (version < row.version || version === row.version && !row.same) throw new TriggerError("schedule_changed", `Schedule ${name} changed: deploy an increased version and stop obsolete schedulers`);
                const clock = await client.query("SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::double precision AS now");
                const previous = version === row.version && row.scheduled_at !== null ? Number(row.scheduled_at) : undefined;
                const { due, cursor } = scheduleDue(timing, previous, clock.rows[0].now);
                const occurrences: ScheduleOccurrence[] = [];
                if (due.length) {
                    const outstanding = timing.overlap === "skip" && (await client.query(`SELECT 1 FROM boring_jobs WHERE name = $1 AND status IN ('pending', 'running') LIMIT 1`, [`@schedule/${name}`])).rowCount;
                    if (!outstanding) for (const scheduledAt of timing.overlap === "skip" ? due.slice(-1) : due) {
                        const occurrence = { id: triggerId("schedule", name, version, scheduledAt), scheduledAt };
                        await insert(client, { id: occurrence.id, name: `@schedule/${name}`, version,
                            payload: { data: input, metadata: occurrence }, origin, policy });
                        occurrences.push(occurrence);
                    }
                }
                await client.query("UPDATE boring_schedule_cursors SET version = $2, definition = $3::jsonb, scheduled_at = $4 WHERE name = $1", [name, version, definition, cursor ?? null]);
                return occurrences;
            });
        },
    };
}
