import { LifecycleError, type ExecutionContext } from "@boringapi/core";
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { PoolClient, PoolConfig } from "pg";
import type { OrderDatabase, OrderStore } from "$modules/orders/ports/storage";
import { order } from "$modules/orders/schemas";
import { migrations } from "./migrations";

export function createDatabase(config: PoolConfig) {
    const pool = new Pool({ max: 10, idleTimeoutMillis: 1000, allowExitOnIdle: true, ...config });
    pool.on("error", error => console.error("Idle database connection failed:", error.message));

    async function transaction<T>(operation: (client: PoolClient) => Promise<T>, execution?: ExecutionContext): Promise<T> {
        execution?.throwIfAborted();
        const client = await pool.connect();
        let discard = false;
        try {
            execution?.throwIfAborted();
            await client.query("BEGIN");
            const result = await operation(client);
            execution?.throwIfAborted();
            await client.query("COMMIT");
            return result;
        } catch (error) {
            try { await client.query("ROLLBACK"); } catch (rollback) {
                discard = true;
                throw new LifecycleError("Transaction and rollback failed", [error, rollback]);
            }
            throw error;
        } finally {
            client.release(discard);
        }
    }

    const database: OrderDatabase = {
        transaction: (execution, operation) => transaction(async client => {
            const store: OrderStore = {
                newId: randomUUID,
                async insert(value) { await client.query("INSERT INTO orders (id, item, quantity) VALUES ($1, $2, $3)", [value.id, value.item, value.quantity]); },
                async recordCreation(value, actorId) { await client.query("INSERT INTO order_events (order_id, actor_id) VALUES ($1, $2)", [value.id, actorId]); },
                async find(id) {
                    const result = await client.query("SELECT id, item, quantity FROM orders WHERE id = $1", [id]);
                    return result.rows[0] ? order.parse(result.rows[0]) : undefined;
                },
            };
            return operation(store);
        }, execution),
    };

    return {
        orders: database,
        close: () => pool.end(),
        async migrate(): Promise<void> {
            await transaction(async client => {
                await client.query("SELECT pg_advisory_xact_lock(1869767780)");
                await client.query("CREATE TABLE IF NOT EXISTS boring_migrations (name text PRIMARY KEY, checksum text NOT NULL)");
                const applied = await client.query<{ name: string; checksum: string }>("SELECT name, checksum FROM boring_migrations ORDER BY name");
                for (const row of applied.rows) {
                    const migration = migrations.find(entry => entry.name === row.name);
                    if (!migration || createHash("sha256").update(migration.sql).digest("hex") !== row.checksum) throw new Error(`Applied migration changed: ${row.name}`);
                }
                for (const migration of migrations) {
                    if (applied.rows.some(row => row.name === migration.name)) continue;
                    await client.query(migration.sql);
                    await client.query("INSERT INTO boring_migrations (name, checksum) VALUES ($1, $2)",
                        [migration.name, createHash("sha256").update(migration.sql).digest("hex")]);
                }
            });
        },
    };
}
