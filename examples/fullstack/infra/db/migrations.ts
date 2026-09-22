import { jobMigration, triggerMigration, publicationMigration } from "@boringapi/jobs-postgres";
/** The database schema has one owner. Append migrations; never edit applied SQL. */
export const migrations = [{
    name: "001_orders",
    sql: `
        CREATE TABLE orders (
            id uuid PRIMARY KEY,
            item text NOT NULL CHECK (length(item) BETWEEN 1 AND 200),
            quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 100)
        );
        CREATE TABLE order_events (
            order_id uuid PRIMARY KEY REFERENCES orders(id),
            actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 100),
            created_at timestamptz NOT NULL DEFAULT now()
        );
    `,
}, {
    name: "002_order_requests",
    sql: `CREATE TABLE order_requests (request_id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES orders(id));`,
}, jobMigration, triggerMigration, publicationMigration, {
    name: "003_order_created_projection",
    sql: `CREATE TABLE order_created_projections (
        event_id uuid PRIMARY KEY,
        order_id uuid NOT NULL REFERENCES orders(id),
        item text NOT NULL,
        quantity integer NOT NULL,
        observed_by text NOT NULL,
        correlation_id text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );`,
}] as const;
