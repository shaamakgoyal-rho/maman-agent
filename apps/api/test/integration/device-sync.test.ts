import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { createDbClient, loadMigrations, migrateUp, withTenant, type DbClient } from "@maman/db";
import { uuidv7, type AgentSpec } from "@maman/contracts";
import { compileAgentSpec } from "@maman/agent-runtime";
import { DEFAULT_ORG_POLICY } from "@maman/policy-engine";
import type { ServerEnv } from "@maman/config";
import { buildServer } from "../../src/server.js";

async function compileSpecFor(org: string, user: string): Promise<AgentSpec> {
  const result = await compileAgentSpec({
    candidate: {
      pattern_id: uuidv7(),
      owner_user_id: user,
      first_seen_at: "2026-07-14T09:40:00.000Z",
      last_seen_at: "2026-07-16T15:00:00.000Z",
      occurrence_count: 6,
      distinct_day_count: 3,
      median_duration_ms: 660_000,
      p90_duration_ms: 780_000,
      canonical_sequence: [],
      episode_ids: [],
      similarity_mean: 0.9,
      repeatability_score: 0.9,
      feasibility_score: 0.8,
      risk_score: 0.3,
      projected_minutes_saved_weekly: 70,
      opportunity_score: 0.72,
      status: "eligible",
    },
    generalized_intent: "reconcile_account_list",
    desired_outcome: "Reconcile the account list with Salesforce.",
    organization_id: org,
    owner_user_id: user,
    budgets: {
      max_runtime_seconds: 300,
      max_model_tokens: 12_000,
      max_cost_usd: 1,
      max_records_read: 1000,
      max_records_written: 20,
    },
    policy: DEFAULT_ORG_POLICY,
    policy_version_id: uuidv7(),
    now: () => new Date("2026-07-18T18:00:00.000Z"),
  });
  if (result.status !== "valid") throw new Error("compile failed");
  return result.spec;
}

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

const asUser = (org: string, user: string) => ({
  "x-dev-org-id": org,
  "x-dev-user-id": user,
  "x-dev-role": "member",
});
const asDevice = (token: string) => ({ authorization: `Bearer ${token}` });

const projection = (n: number) => ({
  schema_version: 1,
  event_id: `018f0000-0000-7000-8000-${String(n).padStart(12, "0")}`,
  occurred_at: "2026-07-18T10:00:00.000Z",
  monotonic_ms: 1000 + n,
  source: "macos_ax",
  app_category: "crm",
  event_type: "record_update",
  sensitivity: "internal",
  excluded_from_learning: false,
});

async function seedOrg(org: string, user: string): Promise<void> {
  await client.sql`INSERT INTO organizations (id, workos_organization_id, name, status, default_timezone) VALUES (${org}, ${"wk_" + org}, 'T', 'active', 'UTC')`;
  await client.sql`INSERT INTO users (id, workos_user_id, email, display_name) VALUES (${user}, ${"wu_" + user}, ${user + "@t.example"}, 'U')`;
  await withTenant(client.sql, { organizationId: org }, async (tx) => {
    await tx`INSERT INTO memberships (organization_id, user_id, role, status) VALUES (${org}, ${user}, 'member', 'active')`;
  });
}

async function enroll(org: string, user: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/devices/enroll",
    headers: asUser(org, user),
    payload: {
      device_public_id: uuidv7(),
      platform: "macos",
      app_version: "0.1.0",
      observer_version: "0.1.0",
      capabilities: ["macos_ax"],
    },
  });
  expect(res.statusCode).toBe(200);
  return res.json().device_token as string;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  client = createDbClient(container.getConnectionUri(), { max: 4 });
  await migrateUp(client.sql, loadMigrations(migrationsDir));
  await seedOrg(orgA, userA);
  await seedOrg(orgB, userB);
  app = buildServer({ env, sql: client.sql });
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await client.close();
  await container.stop();
});

describe("device enrollment + sync round-trip (M12)", () => {
  it("enrolls a device and the token authenticates as a device principal", async () => {
    const token = await enroll(orgA, userA);
    const me = await app.inject({ method: "GET", url: "/v1/me", headers: asDevice(token) });
    expect(me.statusCode).toBe(200);
    const principal = me.json();
    expect(principal.auth_mode).toBe("device");
    expect(principal.organization_id).toBe(orgA);
    expect(principal.device_id).toBeDefined();
  });

  it("syncs redacted projections and dedupes on event_id (at-least-once upload)", async () => {
    const token = await enroll(orgA, userA);
    const events = [projection(1), projection(2), projection(3)];
    const first = await app.inject({
      method: "POST",
      url: "/v1/sync/events",
      headers: asDevice(token),
      payload: { schema_version: 1, events },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ accepted: 3, deduped: 0 });

    // Re-upload the same batch → stored exactly once.
    const second = await app.inject({
      method: "POST",
      url: "/v1/sync/events",
      headers: asDevice(token),
      payload: { schema_version: 1, events },
    });
    expect(second.json()).toMatchObject({ accepted: 0, deduped: 3 });
  });

  it("REJECTS a batch carrying a raw-event field (nothing raw leaves the device)", async () => {
    const token = await enroll(orgA, userA);
    const res = await app.inject({
      method: "POST",
      url: "/v1/sync/events",
      headers: asDevice(token),
      payload: {
        schema_version: 1,
        events: [{ ...projection(9), app: { display_name: "Salesforce" }, value: "typed secret" }],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("sync requires a device token, not a user session", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/sync/events",
      headers: asUser(orgA, userA),
      payload: { schema_version: 1, events: [projection(20)] },
    });
    expect(res.statusCode).toBe(403);
  });

  it("rotation revokes the old token (stateless signature no longer suffices)", async () => {
    const token = await enroll(orgA, userA);
    const rotate = await app.inject({
      method: "POST",
      url: "/v1/devices/rotate",
      headers: asDevice(token),
    });
    expect(rotate.statusCode).toBe(200);
    const newToken = rotate.json().device_token as string;
    expect(newToken).not.toBe(token);

    // Old token is now rejected even though its HMAC is still valid.
    const old = await app.inject({ method: "GET", url: "/v1/me", headers: asDevice(token) });
    expect(old.statusCode).toBe(401);
    // New token works.
    const fresh = await app.inject({ method: "GET", url: "/v1/me", headers: asDevice(newToken) });
    expect(fresh.statusCode).toBe(200);
  });

  it("POST /v1/agents persists a compiled spec and is idempotent on re-post", async () => {
    const spec = await compileSpecFor(orgA, userA);
    const first = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: asUser(orgA, userA),
      payload: { spec },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      agent_id: spec.agent_id,
      version_id: spec.version_id,
      version_number: 1,
    });

    // Re-posting the identical spec returns the same version (no duplicate).
    const again = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: asUser(orgA, userA),
      payload: { spec },
    });
    expect(again.json()).toMatchObject({ version_id: spec.version_id, version_number: 1 });

    const rows = await withTenant(client.sql, { organizationId: orgA }, async (tx) => {
      const r = await tx<
        { n: string }[]
      >`SELECT count(*)::text AS n FROM agent_versions WHERE agent_id = ${spec.agent_id}`;
      return Number(r[0]!.n);
    });
    expect(rows).toBe(1);
  });

  it("POST /v1/agents/compile compiles server-side with the demo provider (deterministic, $0)", async () => {
    const candidate = {
      pattern_id: uuidv7(),
      owner_user_id: userA,
      first_seen_at: "2026-07-14T09:40:00.000Z",
      last_seen_at: "2026-07-16T15:00:00.000Z",
      occurrence_count: 6,
      distinct_day_count: 3,
      median_duration_ms: 660_000,
      p90_duration_ms: 780_000,
      canonical_sequence: [],
      episode_ids: [],
      similarity_mean: 0.9,
      repeatability_score: 0.9,
      feasibility_score: 0.8,
      risk_score: 0.3,
      projected_minutes_saved_weekly: 70,
      opportunity_score: 0.72,
      status: "eligible",
    };
    const res = await app.inject({
      method: "POST",
      url: "/v1/agents/compile",
      headers: asUser(orgA, userA),
      payload: {
        candidate,
        generalized_intent: "reconcile_account_list",
        desired_outcome: "Reconcile the account list with Salesforce.",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.compiled_by).toBe("recipe");
    expect(body.model_cost_usd).toBe(0); // demo provider is free
    expect(body.spec.organization_id).toBe(orgA);
    expect(body.spec.steps.length).toBeGreaterThan(0);
  });

  it("POST /v1/agents records the compile model cost on the version", async () => {
    const spec = await compileSpecFor(orgA, userA);
    const res = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: asUser(orgA, userA),
      payload: {
        spec,
        model_usage: { input_tokens: 1200, output_tokens: 400, model_alias: "claude-sonnet-5" },
        model_cost_usd: 0.0096,
      },
    });
    expect(res.statusCode).toBe(200);
    const stored = await withTenant(client.sql, { organizationId: orgA }, async (tx) => {
      const r = await tx<{ model_cost_usd: string; model_input_tokens: string }[]>`
        SELECT model_cost_usd, model_input_tokens FROM agent_versions WHERE id = ${spec.version_id}
      `;
      return r[0]!;
    });
    expect(Number(stored.model_cost_usd)).toBeCloseTo(0.0096, 6);
    expect(Number(stored.model_input_tokens)).toBe(1200);
  });

  it("POST /v1/agents rejects a spec whose org is not the caller's (no cross-tenant write)", async () => {
    const foreignSpec = await compileSpecFor(orgB, userB);
    const res = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: asUser(orgA, userA), // caller is org A, spec claims org B
      payload: { spec: foreignSpec },
    });
    expect(res.statusCode).toBe(400);
  });

  it("a device token is strictly tenant-scoped: synced rows never cross orgs", async () => {
    const tokenA = await enroll(orgA, userA);
    const tokenB = await enroll(orgB, userB);
    await app.inject({
      method: "POST",
      url: "/v1/sync/events",
      headers: asDevice(tokenA),
      payload: { schema_version: 1, events: [projection(101), projection(102)] },
    });
    await app.inject({
      method: "POST",
      url: "/v1/sync/events",
      headers: asDevice(tokenB),
      payload: { schema_version: 1, events: [projection(201)] },
    });
    const countA = await withTenant(client.sql, { organizationId: orgA }, async (tx) => {
      const r = await tx<
        { n: string }[]
      >`SELECT count(*)::text AS n FROM synced_events WHERE organization_id = ${orgA}`;
      return Number(r[0]!.n);
    });
    const countB = await withTenant(client.sql, { organizationId: orgB }, async (tx) => {
      const r = await tx<
        { n: string }[]
      >`SELECT count(*)::text AS n FROM synced_events WHERE organization_id = ${orgB}`;
      return Number(r[0]!.n);
    });
    // Org B only ever sees its own single event, regardless of org A's uploads.
    expect(countB).toBe(1);
    expect(countA).toBeGreaterThanOrEqual(2);
  });
});
