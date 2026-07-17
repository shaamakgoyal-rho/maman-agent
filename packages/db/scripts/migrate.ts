import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { createDbClient } from "../src/client.js";
import { loadMigrations, migrateDown, migrateUp } from "../src/migrator.js";

const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: join(here, "..", "..", "..", ".env") });

const direction = process.argv[2] ?? "up";
const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  console.error("DATABASE_URL is not set. Run scripts/bootstrap-local-env.sh first.");
  process.exit(1);
}

const migrations = loadMigrations(join(here, "..", "migrations"));
const { sql, close } = createDbClient(databaseUrl, { max: 1 });

try {
  if (direction === "up") {
    const ran = await migrateUp(sql, migrations, console.log);
    console.log(ran.length ? `applied ${ran.length} migration(s)` : "already up to date");
  } else if (direction === "down") {
    const steps = Number(process.argv[3] ?? "1");
    const reverted = await migrateDown(sql, migrations, steps, console.log);
    console.log(reverted.length ? `reverted ${reverted.length} migration(s)` : "nothing to revert");
  } else {
    console.error(`unknown direction: ${direction} (use up|down)`);
    process.exit(1);
  }
} finally {
  await close();
}
