import { jobMigration } from "@boringapi/jobs-postgres";
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
}, jobMigration] as const;
