import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import {
  createDbClient,
  loadMigrations,
  migrateUp,
  verifyAuditChain,
  withTenant,
  type DbClient,
} from "@maman/db";
import { uuidv7 } from "@maman/contracts";
import type { ServerEnv } from "@maman/config";
import { buildServer } from "../../src/server.js";

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
let app: FastifyInstance;

const orgA = uuidv7();
const orgB = uuidv7();
const userA = uuidv7();
const userB = uuidv7();
let agentInA = "";

const env: ServerEnv = {
  NODE_ENV: "test",
  AUTH_MODE: "dev",
  MODEL_PROVIDER: "demo",
  CONNECTOR_MODE: "demo",
  DATABASE_URL: "postgres://localhost/x",
  REDIS_URL: "redis://localhost:6379",
  TEMPORAL_ADDRESS: "localhost:7233",
  TEMPORAL_NAMESPACE: "default",
  API_BASE_URL: "http://localhost:4000",
  WEB_BASE_URL: "http://localhost:3000",
  DEVICE_TOKEN_SIGNING_SECRET: "d".repeat(43),
  OAUTH_STATE_SIGNING_SECRET: "o".repeat(43),
  CONNECTOR_ENCRYPTION_MASTER_KEY: "c".repeat(43),
};

async function seedOrg(org: string, user: string): Promise<string> {
  await client.sql`INSERT INTO organizations (id, workos_organization_id, name, status, default_timezone) VALUES (${org}, ${"wk_" + org}, 'T', 'active', 'UTC')`;
  await client.sql`INSERT INTO users (id, workos_user_id, email, display_name) VALUES (${user}, ${"wu_" + user}, ${user + "@t.example"}, 'U')`;
  let agentId = "";
  await withTenant(client.sql, { organizationId: org }, async (tx) => {
    await tx`INSERT INTO memberships (organization_id, user_id, role, status) VALUES (${org}, ${user}, 'member', 'active')`;
    agentId = uuidv7();
    const versionId = uuidv7();
    const policyId = uuidv7();
    await tx`INSERT INTO policy_versions (id, organization_id, version_number, policy, sha256, created_by_user_id) VALUES (${policyId}, ${org}, 1, '{}', ${"s" + org}, ${user})`;
    await tx`INSERT INTO agents (id, organization_id, owner_user_id, name, description, state, current_version_id) VALUES (${agentId}, ${org}, ${user}, 'A', 'd', 'supervised', ${versionId})`;
    await tx`INSERT INTO agent_versions (id, organization_id, agent_id, version_number, schema_version, spec, spec_sha256, created_by_type, policy_version_id) VALUES (${versionId}, ${org}, ${agentId}, 1, 1, '{}', ${"sp" + org}, 'compiler', ${policyId})`;
    await tx`INSERT INTO agent_runs (id, organization_id, owner_user_id, agent_id, agent_version_id, temporal_workflow_id, trigger_type, trigger_idempotency_key, mode, status, policy_version_id, requested_at) VALUES (${uuidv7()}, ${org}, ${user}, ${agentId}, ${versionId}, ${"wf" + org}, 'manual', ${"idem" + org}, 'supervised', 'queued', ${policyId}, now())`;
  });
  return agentId;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  client = createDbClient(container.getConnectionUri(), { max: 4 });
  await migrateUp(client.sql, loadMigrations(migrationsDir));
  agentInA = await seedOrg(orgA, userA);
  await seedOrg(orgB, userB);
  app = buildServer({ env, sql: client.sql });
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await client.close();
  await container.stop();
});

const asUser = (org: string, user: string) => ({
  "x-dev-org-id": org,
  "x-dev-user-id": user,
  "x-dev-role": "member",
});

describe("security invariants (M10)", () => {
  it("an unauthenticated request is rejected", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/me" });
    expect([401, 400]).toContain(res.statusCode);
  });

  it("cross-tenant agent access returns 404, never 403 (no existence leak)", async () => {
    // User B asks for an agent that belongs to org A.
    const res = await app.inject({
      method: "GET",
      url: `/v1/agents/${agentInA}`,
      headers: asUser(orgB, userB),
    });
    expect(res.statusCode).toBe(404);
    expect(res.statusCode).not.toBe(403);
  });

  it("the kill switch pauses all agents and halts runs for the caller's org only", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/kill-switch",
      headers: asUser(orgA, userA),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.paused_agents).toBeGreaterThanOrEqual(1);
    expect(body.halted_runs).toBeGreaterThanOrEqual(1);

    const [aState, bState] = await Promise.all([
      withTenant(client.sql, { organizationId: orgA }, async (tx) => {
        const rows = await tx<
          { state: string }[]
        >`SELECT state FROM agents WHERE organization_id = ${orgA}`;
        return rows[0]!.state;
      }),
      withTenant(client.sql, { organizationId: orgB }, async (tx) => {
        const rows = await tx<
          { state: string }[]
        >`SELECT state FROM agents WHERE organization_id = ${orgB}`;
        return rows[0]!.state;
      }),
    ]);
    expect(aState).toBe("paused");
    // Org B is untouched — the kill switch is strictly tenant-scoped.
    expect(bState).toBe("supervised");
  });

  it("the kill switch writes a valid, tamper-evident audit event", async () => {
    const chain = await verifyAuditChain(client.sql, { organizationId: orgA });
    expect(chain.valid).toBe(true);
    if (chain.valid) expect(chain.event_count).toBeGreaterThanOrEqual(1);
  });

  it("dev auth mode is impossible in production (fail closed)", () => {
    expect(() =>
      buildServer({ env: { ...env, NODE_ENV: "production", AUTH_MODE: "dev" }, sql: client.sql }),
    ).toThrow();
  });
});
