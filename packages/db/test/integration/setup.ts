import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createDbClient, type DbClient } from "../../src/client.js";
import { loadMigrations, migrateUp, type Migration } from "../../src/migrator.js";

const here = dirname(fileURLToPath(import.meta.url));

export const migrationsDir = join(here, "..", "..", "migrations");

export type TestDb = {
  container: StartedPostgreSqlContainer;
  client: DbClient;
  migrations: Migration[];
  connectionUri: string;
  stop: () => Promise<void>;
};

export async function startTestDb(): Promise<TestDb> {
  const container = await new PostgreSqlContainer("postgres:17-alpine").start();
  const connectionUri = container.getConnectionUri();
  const client = createDbClient(connectionUri, { max: 5 });
  const migrations = loadMigrations(migrationsDir);
  await migrateUp(client.sql, migrations);
  return {
    container,
    client,
    migrations,
    connectionUri,
    stop: async () => {
      await client.close();
      await container.stop();
    },
  };
}
