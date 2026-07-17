import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createDbClient, loadMigrations, migrateUp, withTenant, type DbClient } from "@maman/db";
import { uuidv7 } from "@maman/contracts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { adminOverview } from "../../src/admin.js";

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "packages",
  "db",
  "migrations",
);

let container: StartedPostgreSqlContainer;
let client: DbClient;
let orgId: string;

async function seedOrgWithRoi(userCount: number): Promise<string> {
  const org = uuidv7();
  await client.sql`
    INSERT INTO organizations (id, workos_organization_id, name, status, default_timezone)
    VALUES (${org}, ${"wk_" + org}, 'Test', 'active', 'UTC')
  `;
  await withTenant(client.sql, { organizationId: org }, async (tx) => {
    for (let i = 0; i < userCount; i++) {
      const userId = uuidv7();
      await client.sql`INSERT INTO users (id, workos_user_id, email, display_name) VALUES (${userId}, ${"wu_" + userId}, ${"u" + i + "@t.example"}, 'U')`;
      await tx`INSERT INTO memberships (organization_id, user_id, role, status) VALUES (${org}, ${userId}, 'member', 'active')`;
      const agentId = uuidv7();
      const versionId = uuidv7();
      const policyId = uuidv7();
      await tx`INSERT INTO policy_versions (id, organization_id, version_number, policy, sha256, created_by_user_id) VALUES (${policyId}, ${org}, ${i}, '{}', ${"s" + i}, ${userId})`;
      await tx`INSERT INTO agents (id, organization_id, owner_user_id, name, description, state) VALUES (${agentId}, ${org}, ${userId}, 'A', 'd', 'supervised')`;
      await tx`INSERT INTO agent_versions (id, organization_id, agent_id, version_number, schema_version, spec, spec_sha256, created_by_type, policy_version_id) VALUES (${versionId}, ${org}, ${agentId}, 1, 1, '{}', ${"sp" + i}, 'compiler', ${policyId})`;
      const runId = uuidv7();
      await tx`INSERT INTO agent_runs (id, organization_id, owner_user_id, agent_id, agent_version_id, temporal_workflow_id, trigger_type, trigger_idempotency_key, mode, status, policy_version_id, requested_at, model_cost_usd, connector_cost_usd) VALUES (${runId}, ${org}, ${userId}, ${agentId}, ${versionId}, ${"wf" + runId}, 'manual', ${"idem" + runId}, 'supervised', 'completed', ${policyId}, now(), 0.01, 0.07)`;
      await tx`INSERT INTO roi_measurements (id, organization_id, owner_user_id, agent_id, run_id, baseline_ms, automated_human_ms, intervention_ms, verified_saved_ms, gross_value_usd, model_cost_usd, connector_cost_usd, infrastructure_cost_usd, net_value_usd, verification_status) VALUES (${uuidv7()}, ${org}, ${userId}, ${agentId}, ${runId}, 1200000, 60000, 60000, ${17 * 60_000}, 21.25, 0.01, 0.07, 0, 21.17, 'verified')`;
    }
  });
  return org;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  client = createDbClient(container.getConnectionUri(), { max: 4 });
  await migrateUp(client.sql, loadMigrations(migrationsDir));
  orgId = await seedOrgWithRoi(6);
}, 180_000);

afterAll(async () => {
  await client.close();
  await container.stop();
});

describe("admin overview aggregation", () => {
  it("reports aggregate value for a six-user cohort (matches the sum)", async () => {
    const overview = await adminOverview(client.sql, orgId);
    expect(overview.seats.active_users).toBe(6);
    expect(overview.runs.completed).toBe(6);
    expect(overview.value.suppressed).toBe(false);
    if (!overview.value.suppressed) {
      expect(overview.value.cohort_size).toBe(6);
      // 6 users × 17 min = 102 min = 1.7h
      expect(overview.value.verified_hours).toBeCloseTo(1.7, 1);
      expect(overview.value.net_value_usd).toBeCloseTo(6 * 21.17, 1);
    }
    expect(overview.agents.supervised).toBe(6);
  });

  it("suppresses aggregate value below the five-user cohort minimum", async () => {
    const smallOrg = await seedOrgWithRoi(4);
    const overview = await adminOverview(client.sql, smallOrg);
    expect(overview.value.suppressed).toBe(true);
    if (overview.value.suppressed) expect(overview.value.cohort_size).toBe(4);
  });

  it("never leaks another org's rows into the aggregate", async () => {
    const other = await seedOrgWithRoi(6);
    const a = await adminOverview(client.sql, orgId);
    const b = await adminOverview(client.sql, other);
    expect(a.seats.active_users).toBe(6);
    expect(b.seats.active_users).toBe(6);
  });
});
