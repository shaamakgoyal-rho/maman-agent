import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { createDbClient, loadMigrations, migrateUp, withTenant, type DbClient } from "@maman/db";
import { uuidv7, type AgentSpec } from "@maman/contracts";
import { compileAgentSpec, DemoSalesforceWorld, demoAdapterRegistry } from "@maman/agent-runtime";
import { createActivities } from "@maman/worker";
import { DEFAULT_ORG_POLICY } from "@maman/policy-engine";
import type { ServerEnv } from "@maman/config";
import { buildServer } from "../../src/server.js";
import { TemporalRunOrchestrator } from "../../src/orchestrator.js";

const require = createRequire(import.meta.url);
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
const TASK_QUEUE = "maman-agent-runs";

let container: StartedPostgreSqlContainer;
let client: DbClient;
let env: TestWorkflowEnvironment;
let app: FastifyInstance;
let world: DemoSalesforceWorld;

const orgId = uuidv7();
const userId = uuidv7();

const serverEnv: ServerEnv = {
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

const asUser = () => ({
  "x-dev-org-id": orgId,
  "x-dev-user-id": userId,
  "x-dev-role": "member",
});
const asDevice = (token: string) => ({ authorization: `Bearer ${token}` });

async function compileSpec(): Promise<AgentSpec> {
  const result = await compileAgentSpec({
    candidate: {
      pattern_id: uuidv7(),
      owner_user_id: userId,
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
    organization_id: orgId,
    owner_user_id: userId,
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

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  client = createDbClient(container.getConnectionUri(), { max: 4 });
  await migrateUp(client.sql, loadMigrations(migrationsDir));
  await client.sql`INSERT INTO organizations (id, workos_organization_id, name, status, default_timezone) VALUES (${orgId}, ${"wk_" + orgId}, 'T', 'active', 'UTC')`;
  await client.sql`INSERT INTO users (id, workos_user_id, email, display_name) VALUES (${userId}, ${"wu_" + userId}, 'u@t.example', 'U')`;
  await withTenant(client.sql, { organizationId: orgId }, async (tx) => {
    await tx`INSERT INTO memberships (organization_id, user_id, role, status) VALUES (${orgId}, ${userId}, 'member', 'active')`;
  });

  // Real-time env: external approvals arrive over HTTP, so we must not let a
  // time-skipping env fast-forward the approval timer before the signal lands.
  env = await TestWorkflowEnvironment.createLocal();
  app = buildServer({
    env: serverEnv,
    sql: client.sql,
    orchestrator: new TemporalRunOrchestrator(env.client.workflow, TASK_QUEUE),
  });
  await app.ready();
}, 240_000);

afterAll(async () => {
  await app?.close();
  await env?.teardown();
  await client.close();
  await container.stop();
});

describe("agent-lifecycle round-trip over Temporal, approved from a device token (M12)", () => {
  it("enroll → create agent → run → approve from device → write applied", async () => {
    // 1. Enroll a device (user session → device token stored client-side).
    const enroll = await app.inject({
      method: "POST",
      url: "/v1/devices/enroll",
      headers: asUser(),
      payload: {
        device_public_id: uuidv7(),
        platform: "macos",
        app_version: "0.1.0",
        observer_version: "0.1.0",
        capabilities: ["macos_ax"],
      },
    });
    expect(enroll.statusCode).toBe(200);
    const deviceToken = enroll.json().device_token as string;

    // 2. Create the agent (persist the compiled spec) — from the device.
    const spec = await compileSpec();
    const create = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: asDevice(deviceToken),
      payload: { spec },
    });
    expect(create.statusCode).toBe(200);
    const agentId = create.json().agent_id as string;

    // 3. Run the whole loop on a real worker; drive approval from the device.
    world = new DemoSalesforceWorld();
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: TASK_QUEUE,
      workflowsPath: require.resolve("@maman/agent-runtime/workflow"),
      activities: createActivities({
        registry: demoAdapterRegistry(world),
        now: () => new Date("2026-07-18T18:05:00Z"),
        sink: {
          runStatus: () => {},
          stepResult: () => {},
          approvalRequested: () => {},
          receipt: () => {},
        },
      }),
    });

    const result = await worker.runUntil(async () => {
      // Trigger a supervised run from the device token.
      const run = await app.inject({
        method: "POST",
        url: `/v1/agents/${agentId}/runs`,
        headers: asDevice(deviceToken),
        payload: { mode: "supervised", trigger_idempotency_key: "e2e-idem-1" },
      });
      expect(run.statusCode).toBe(200);
      const runId = run.json().run_id as string;

      // Duplicate trigger returns the same run (no second workflow).
      const dup = await app.inject({
        method: "POST",
        url: `/v1/agents/${agentId}/runs`,
        headers: asDevice(deviceToken),
        payload: { mode: "supervised", trigger_idempotency_key: "e2e-idem-1" },
      });
      expect(dup.json().run_id).toBe(runId);
      expect(dup.json().duplicate).toBe(true);

      // Poll for the pending approval (worker runs read + propose, then waits).
      let pending: { step_id: string; diff_sha256: string } | null = null;
      for (let i = 0; i < 60 && !pending; i++) {
        const res = await app.inject({
          method: "GET",
          url: `/v1/runs/${runId}/pending-approval`,
          headers: asDevice(deviceToken),
        });
        pending = res.json().pending;
        if (!pending) await env.sleep("1s");
      }
      expect(pending, "a write approval should be pending").not.toBeNull();

      // The proposed diff is readable over the API (panel renders it) and its
      // hash matches the pending approval — same content the write is bound to.
      const proposal = await app.inject({
        method: "GET",
        url: `/v1/runs/${runId}/proposal`,
        headers: asDevice(deviceToken),
      });
      expect(proposal.statusCode).toBe(200);
      expect(proposal.json().diff, "the proposed diff is surfaced").not.toBeNull();
      expect(proposal.json().diff.summary.change_count).toBeGreaterThan(0);

      // A forged diff hash is refused (bound to step + diff hash).
      const forged = await app.inject({
        method: "POST",
        url: `/v1/runs/${runId}/approve`,
        headers: asDevice(deviceToken),
        payload: { step_id: pending!.step_id, diff_hash: "deadbeef" },
      });
      expect(forged.statusCode).toBe(409);

      // Approve with the real diff hash — from the device token.
      const approve = await app.inject({
        method: "POST",
        url: `/v1/runs/${runId}/approve`,
        headers: asDevice(deviceToken),
        payload: { step_id: pending!.step_id, diff_hash: pending!.diff_sha256 },
      });
      expect(approve.statusCode).toBe(200);
      expect(approve.json().approved).toBe(true);

      // Keep the worker alive until the workflow completes, so the approved
      // write + verification actually run. workflowId is `run-<runId>`.
      const finalStatus = (await env.client.workflow.getHandle(`run-${runId}`).result()) as {
        status: string;
        completed_writes: number;
      };
      expect(finalStatus.status).toBe("completed");
      expect(finalStatus.completed_writes).toBe(1);

      // The immutable ExecutionReceipt renders from the server (incl. model cost
      // line) — this is what the panel shows after a server-backed run.
      const receiptRes = await app.inject({
        method: "GET",
        url: `/v1/runs/${runId}/receipt`,
        headers: asDevice(deviceToken),
      });
      expect(receiptRes.statusCode).toBe(200);
      const receipt = receiptRes.json().receipt;
      expect(receipt, "the receipt is surfaced once finalized").not.toBeNull();
      expect(receipt.run_id).toBe(runId);
      expect(receipt.totals).toHaveProperty("model_cost_usd");
      // The reconciliation write step applies all proposed records (4) at once.
      expect(receipt.totals.writes_completed).toBe(4);
      return runId;
    });

    // 4. The write was applied exactly once against the (demo) Salesforce,
    //    driven entirely by an approval presented with a device token.
    expect(result).toBeTruthy();
    expect(world.applied.size).toBe(1);
    expect(world.accounts.find((a) => a.id === "001DEMO000001")!.owner).toBe("Alex");
  });

  it("a shadow run needs no approval and writes nothing", async () => {
    const spec = await compileSpec();
    // New agent version (same agent) via a fresh compile → new version_id.
    const create = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: asUser(),
      payload: { spec },
    });
    const agentId = create.json().agent_id as string;

    const shadowWorld = new DemoSalesforceWorld();
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: TASK_QUEUE,
      workflowsPath: require.resolve("@maman/agent-runtime/workflow"),
      activities: createActivities({
        registry: demoAdapterRegistry(shadowWorld),
        now: () => new Date("2026-07-18T18:05:00Z"),
        sink: {
          runStatus: () => {},
          stepResult: () => {},
          approvalRequested: () => {},
          receipt: () => {},
        },
      }),
    });

    await worker.runUntil(async () => {
      const run = await app.inject({
        method: "POST",
        url: `/v1/agents/${agentId}/runs`,
        headers: asUser(),
        payload: { mode: "shadow", trigger_idempotency_key: "e2e-shadow-1" },
      });
      const runId = run.json().run_id as string;
      // Shadow has no approval gate — it runs straight to completion.
      const final = (await env.client.workflow.getHandle(`run-${runId}`).result()) as {
        status: string;
        completed_writes: number;
      };
      expect(final.status).toBe("completed");
      expect(final.completed_writes).toBe(0);
    });

    expect(shadowWorld.applied.size).toBe(0);
  });
});
