import { createDatabase } from "$infra/db/database";
import { databaseUrl } from "$infra/config";

async function main() {
    const database = createDatabase({ connectionString: databaseUrl() });
    try { await database.migrate(); console.info("Database migrations applied."); }
    finally { await database.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
