import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Sql } from "postgres";

/**
 * Deterministic SQL migrator with explicit up/down pairs.
 * Files: migrations/NNNN_name.up.sql and NNNN_name.down.sql, applied in order,
 * each inside its own transaction, tracked in schema_migrations.
 */

export type Migration = {
  id: string;
  upSql: string;
  downSql: string;
};

export function loadMigrations(dir: string): Migration[] {
  const files = readdirSync(dir);
  const ups = files.filter((f) => f.endsWith(".up.sql")).sort();
  return ups.map((up) => {
    const id = up.replace(/\.up\.sql$/, "");
    const down = `${id}.down.sql`;
    if (!files.includes(down)) {
      throw new Error(`migration ${id} is missing its down file`);
    }
    return {
      id,
      upSql: readFileSync(join(dir, up), "utf8"),
      downSql: readFileSync(join(dir, down), "utf8"),
    };
  });
}

async function ensureMigrationsTable(sql: Sql): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;
}

export async function appliedMigrationIds(sql: Sql): Promise<string[]> {
  await ensureMigrationsTable(sql);
  const rows = await sql<{ id: string }[]>`SELECT id FROM schema_migrations ORDER BY id`;
  return rows.map((r) => r.id);
}

export async function migrateUp(
  sql: Sql,
  migrations: Migration[],
  log: (msg: string) => void = () => {},
): Promise<string[]> {
  const applied = new Set(await appliedMigrationIds(sql));
  const ran: string[] = [];
  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    await sql.begin(async (tx) => {
      await tx.unsafe(m.upSql);
      await tx`INSERT INTO schema_migrations (id) VALUES (${m.id})`;
    });
    log(`applied ${m.id}`);
    ran.push(m.id);
  }
  return ran;
}

/** Rolls back the most recent `steps` migrations (default 1). */
export async function migrateDown(
  sql: Sql,
  migrations: Migration[],
  steps = 1,
  log: (msg: string) => void = () => {},
): Promise<string[]> {
  const applied = await appliedMigrationIds(sql);
  const byId = new Map(migrations.map((m) => [m.id, m]));
  const toRevert = applied.slice(-steps).reverse();
  const reverted: string[] = [];
  for (const id of toRevert) {
    const m = byId.get(id);
    if (!m) throw new Error(`applied migration ${id} not found on disk`);
    await sql.begin(async (tx) => {
      await tx.unsafe(m.downSql);
      await tx`DELETE FROM schema_migrations WHERE id = ${id}`;
    });
    log(`reverted ${id}`);
    reverted.push(id);
  }
  return reverted;
}
