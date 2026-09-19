import { join } from "node:path";
import { registerTypeScript } from "../../src/register";

if (__filename.endsWith(".ts")) registerTypeScript(join(__dirname, "api"), join(__dirname, "../../tsconfig.fullstack.json"));

async function main() {
    const { createDatabase } = await import("./infra/db/database");
    const { databaseUrl } = await import("./infra/config");
    const database = createDatabase({ connectionString: databaseUrl() });
    try { await database.migrate(); console.info("Database migrations applied."); }
    finally { await database.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
