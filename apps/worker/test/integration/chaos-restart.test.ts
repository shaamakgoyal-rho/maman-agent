import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { createRequire } from "node:module";
import { uuidv7, type AgentRunInput, type AgentSpec } from "@maman/contracts";
import { compileAgentSpec, DemoSalesforceWorld, demoAdapterRegistry } from "@maman/agent-runtime";
import {
  agentRunWorkflow,
  approveStepSignal,
  getPendingApprovalQuery,
  type AgentRunWorkflowResult,
} from "@maman/agent-runtime/workflow";
import { DEFAULT_ORG_POLICY } from "@maman/policy-engine";
import {
  createActivities,
  __resetRunStateForTests,
  type PersistenceSink,
} from "../../src/activities.js";

const require = createRequire(import.meta.url);
const TASK_QUEUE = "maman-agent-runs";
const orgId = uuidv7();
const userId = uuidv7();

let env: TestWorkflowEnvironment;

const silentSink: PersistenceSink = {
  runStatus: () => {},
  stepResult: () => {},
  approvalRequested: () => {},
  receipt: () => {},
};

function makeWorker(world: DemoSalesforceWorld) {
  return Worker.create({
    connection: env.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowsPath: require.resolve("@maman/agent-runtime/workflow"),
    activities: createActivities({
      registry: demoAdapterRegistry(world),
      now: () => new Date("2026-07-20T18:05:00Z"),
      sink: silentSink,
    }),
  });
}

async function buildSpec(): Promise<AgentSpec> {
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
    now: () => new Date("2026-07-20T18:00:00.000Z"),
  });
  if (result.status !== "valid") throw new Error("compile failed");
  return result.spec;
}

function runInput(spec: AgentSpec): AgentRunInput {
  return {
    run_id: uuidv7(),
    agent_id: spec.agent_id,
    agent_version_id: spec.version_id,
    organization_id: orgId,
    owner_user_id: userId,
    mode: "supervised",
    trigger: { type: "manual", idempotency_key: uuidv7() },
    agent_inputs: {},
    policy_version_id: uuidv7(),
    requested_at: "2026-07-20T18:00:00.000Z",
  };
}

beforeAll(async () => {
  // Real-time env so the approval timer isn't fast-forwarded during the worker
  // swap (the workflow sits in waiting_approval across the "restart").
  env = await TestWorkflowEnvironment.createLocal();
}, 240_000);

afterAll(async () => {
  await env?.teardown();
});

describe("chaos: worker restart mid-run (M17)", () => {
  it("approval state survives a worker restart; the approved write still lands", async () => {
    const spec = await buildSpec();
    const run = runInput(spec);
    const workflowId = `chaos-${run.run_id}`;

    // Start the durable run (state lives in Temporal, not the worker).
    await env.client.workflow.start(agentRunWorkflow, {
      workflowId,
      taskQueue: TASK_QUEUE,
      args: [{ run, spec }],
    });
    const handle = env.client.workflow.getHandle(workflowId);

    // Worker #1 runs the reads + propose, then the workflow blocks on approval.
    const world1 = new DemoSalesforceWorld();
    const worker1 = await makeWorker(world1);
    const pending = await worker1.runUntil(async () => {
      let p: { step_id: string; diff_sha256: string } | null = null;
      for (let i = 0; i < 60 && !p; i++) {
        p = await handle.query(getPendingApprovalQuery);
        if (!p) await new Promise((r) => setTimeout(r, 250));
      }
      return p;
    });
    expect(pending, "the run reached the approval gate").not.toBeNull();
    // Nothing was written yet — the run is waiting for a human.
    expect(world1.applied.size).toBe(0);

    // ── simulate a real worker process restart ──
    // Drop worker #1's in-memory run cache and bring up a fresh worker with a
    // brand-new demo world. If the write depended on worker #1's memory it would
    // now fail; instead the approved diff is carried in the workflow history.
    __resetRunStateForTests();
    const world2 = new DemoSalesforceWorld();
    const worker2 = await makeWorker(world2);

    const result = (await worker2.runUntil(async () => {
      await handle.signal(approveStepSignal, {
        step_id: pending!.step_id,
        diff_hash: pending!.diff_sha256,
        approver_user_id: userId,
      });
      return handle.result();
    })) as AgentRunWorkflowResult;

    // The run completed after the restart, writing exactly once.
    expect(result.status).toBe("completed");
    expect(result.completed_writes).toBe(1);
    // The write landed on the FRESH world — proof it came from the durable
    // workflow history, not worker #1's lost in-memory diff cache.
    expect(world2.applied.size).toBe(1);
    expect(world2.accounts.find((a) => a.id === "001DEMO000001")!.owner).toBe("Alex");
    // Worker #1's world was never written (it stopped before approval).
    expect(world1.applied.size).toBe(0);
    expect(world1.accounts.find((a) => a.id === "001DEMO000001")!.owner).toBe("Jordan");
  });
});
