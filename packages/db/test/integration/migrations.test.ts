import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createDbClient, type DbClient } from "../../src/client.js";
import { appliedMigrationIds, loadMigrations, migrateDown, migrateUp } from "../../src/migrator.js";
import { migrationsDir } from "./setup.js";

let container: StartedPostgreSqlContainer;
let client: DbClient;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  client = createDbClient(container.getConnectionUri(), { max: 2 });
});

afterAll(async () => {
  await client.close();
  await container.stop();
});

describe("migration lifecycle on an empty database", () => {
  it("applies every migration up, then reverts every migration down, then re-applies", async () => {
    const migrations = loadMigrations(migrationsDir);
    expect(migrations.length).toBeGreaterThanOrEqual(5);

    // up
    const ran = await migrateUp(client.sql, migrations);
    expect(ran).toEqual(migrations.map((m) => m.id));

    const tables = await client.sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
    `;
    const names = tables.map((t) => t.table_name);
    for (const expected of [
      "organizations",
      "users",
      "memberships",
      "devices",
      "desktop_auth_transactions",
      "device_sessions",
      "patterns",
      "recommendations",
      "agents",
      "agent_versions",
      "agent_runs",
      "run_steps",
      "approvals",
      "policy_versions",
      "usage_reservations",
      "provider_price_versions",
      "connector_accounts",
      "roi_baselines",
      "roi_measurements",
      "audit_events",
      "audit_chain_heads",
    ]) {
      expect(names).toContain(expected);
    }

    // full down
    const reverted = await migrateDown(client.sql, migrations, migrations.length);
    expect(reverted.length).toBe(migrations.length);
    const after = await client.sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name <> 'schema_migrations'
    `;
    expect(after.length).toBe(0);

    // idempotent re-up
    const reran = await migrateUp(client.sql, migrations);
    expect(reran.length).toBe(migrations.length);
    expect(await appliedMigrationIds(client.sql)).toEqual(migrations.map((m) => m.id));
  });

  it("is a no-op when already up to date", async () => {
    const migrations = loadMigrations(migrationsDir);
    const ran = await migrateUp(client.sql, migrations);
    expect(ran.length).toBe(0);
  });

  it("enforces RLS on every tenant table", async () => {
    const rows = await client.sql<{ tablename: string; rowsecurity: boolean }[]>`
      SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public'
    `;
    const rls = new Map(rows.map((r) => [r.tablename, r.rowsecurity]));
    const tenantTables = [
      "memberships",
      "devices",
      "device_sessions",
      "patterns",
      "recommendations",
      "agents",
      "agent_versions",
      "agent_runs",
      "run_steps",
      "approvals",
      "policy_versions",
      "usage_reservations",
      "connector_accounts",
      "roi_baselines",
      "roi_measurements",
      "audit_events",
      "audit_chain_heads",
    ];
    for (const table of tenantTables) {
      expect(rls.get(table), `RLS missing on ${table}`).toBe(true);
    }
  });
});
