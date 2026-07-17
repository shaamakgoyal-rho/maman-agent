import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { createRequire } from "node:module";
import { uuidv7, type AgentRunInput, type AgentSpec } from "@maman/contracts";
import { compileAgentSpec, DemoSalesforceWorld } from "@maman/agent-runtime";
import {
  agentRunWorkflow,
  approveStepSignal,
  getStatusQuery,
  getPendingApprovalQuery,
  rejectStepSignal,
  type AgentRunWorkflowResult,
} from "@maman/agent-runtime/workflow";
import { DEFAULT_ORG_POLICY } from "@maman/policy-engine";
import { createActivities } from "../../src/activities.js";

const require = createRequire(import.meta.url);
let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
}, 180_000);

afterAll(async () => {
  await env?.teardown();
});

async function buildSpec(): Promise<AgentSpec> {
  const result = await compileAgentSpec({
    candidate: {
      pattern_id: uuidv7(),
      owner_user_id: uuidv7(),
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
    desired_outcome: "Reconcile the demo account list with Salesforce.",
    organization_id: uuidv7(),
    owner_user_id: uuidv7(),
    budgets: {
      max_runtime_seconds: 300,
      max_model_tokens: 12_000,
      max_cost_usd: 1,
      max_records_read: 1000,
      max_records_written: 20,
    },
    policy: DEFAULT_ORG_POLICY,
    policy_version_id: uuidv7(),
    now: () => new Date("2026-07-17T18:00:00.000Z"),
  });
  if (result.status !== "valid") throw new Error("compile failed");
  return result.spec;
}

function runInput(spec: AgentSpec, mode: AgentRunInput["mode"], idem: string): AgentRunInput {
  return {
    run_id: uuidv7(),
    agent_id: spec.agent_id,
    agent_version_id: spec.version_id,
    organization_id: spec.organization_id,
    owner_user_id: spec.owner_user_id,
    mode,
    trigger: { type: "manual", idempotency_key: idem },
    agent_inputs: {},
    policy_version_id: uuidv7(),
    requested_at: "2026-07-17T18:00:00.000Z",
  };
}

type Receipt = { totals: { writes_proposed: number; writes_completed: number }; mode: string };

async function withWorker<T>(
  world: DemoSalesforceWorld,
  taskQueue: string,
  fn: () => Promise<T>,
): Promise<{ result: T; receipts: Receipt[] }> {
  const receipts: Receipt[] = [];
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowsPath: require.resolve("@maman/agent-runtime/workflow"),
    activities: createActivities({
      world,
      now: () => new Date("2026-07-17T18:05:00.000Z"),
      sink: {
        runStatus: () => {},
        stepResult: () => {},
        approvalRequested: () => {},
        receipt: (r) => {
          receipts.push(r as Receipt);
        },
      },
    }),
  });
  const result = await worker.runUntil(fn());
  return { result, receipts };
}

describe("agentRunWorkflow (M7 gate)", () => {
  it("shadow run: proposes the four-change diff and writes nothing", async () => {
    const spec = await buildSpec();
    const world = new DemoSalesforceWorld();
    const { result, receipts } = await withWorker(world, "q-shadow", () =>
      env.client.workflow.execute(agentRunWorkflow, {
        workflowId: `wf-${uuidv7()}`,
        taskQueue: "q-shadow",
        args: [{ run: runInput(spec, "shadow", "idem-shadow-1"), spec }],
      }),
    );
    const workflowResult = result as AgentRunWorkflowResult;
    expect(workflowResult.status).toBe("completed");
    expect(workflowResult.proposed_changes).toBe(4);
    expect(workflowResult.completed_writes).toBe(0);
    // The demo Salesforce org is untouched.
    expect(world.accounts.find((a) => a.id === "001DEMO000001")!.owner).toBe("Jordan");
    expect(world.applied.size).toBe(0);
    expect(receipts[0]!.totals.writes_completed).toBe(0);
  });

  it("supervised run: pauses for approval, then writes once and verifies", async () => {
    const spec = await buildSpec();
    const world = new DemoSalesforceWorld();
    const run = runInput(spec, "supervised", "idem-sup-1");
    const workflowId = `wf-${uuidv7()}`;

    const { result } = await withWorker(world, "q-sup", async () => {
      const handle = await env.client.workflow.start(agentRunWorkflow, {
        workflowId,
        taskQueue: "q-sup",
        args: [{ run, spec }],
      });

      // Wait until the workflow is blocked on approval.
      let pending: { step_id: string; diff_sha256: string } | null = null;
      for (let i = 0; i < 50 && !pending; i++) {
        pending = await handle.query(getPendingApprovalQuery);
        if (!pending) await env.sleep("1s");
      }
      expect(pending).not.toBeNull();
      expect(await handle.query(getStatusQuery)).toBe("waiting_approval");

      // Approve bound to the exact diff hash.
      await handle.signal(approveStepSignal, {
        step_id: pending!.step_id,
        diff_hash: pending!.diff_sha256,
        approver_user_id: uuidv7(),
      });
      return handle.result();
    });

    const workflowResult = result as AgentRunWorkflowResult;
    expect(workflowResult.status).toBe("completed");
    expect(workflowResult.completed_writes).toBe(1);
    // The fake Salesforce actually changed and verification passed.
    expect(world.accounts.find((a) => a.id === "001DEMO000001")!.owner).toBe("Alex");
    expect(world.accounts.find((a) => a.id === "001DEMO000004")!.segment).toBe("SMB");
    expect(world.applied.size).toBe(1);
  });

  it("rejecting the approval cancels the run without any write", async () => {
    const spec = await buildSpec();
    const world = new DemoSalesforceWorld();
    const { result } = await withWorker(world, "q-rej", async () => {
      const handle = await env.client.workflow.start(agentRunWorkflow, {
        workflowId: `wf-${uuidv7()}`,
        taskQueue: "q-rej",
        args: [{ run: runInput(spec, "supervised", "idem-rej-1"), spec }],
      });
      let pending: { step_id: string; diff_sha256: string } | null = null;
      for (let i = 0; i < 50 && !pending; i++) {
        pending = await handle.query(getPendingApprovalQuery);
        if (!pending) await env.sleep("1s");
      }
      await handle.signal(rejectStepSignal, { step_id: pending!.step_id, reason: "not now" });
      return handle.result();
    });
    expect((result as AgentRunWorkflowResult).status).toBe("cancelled");
    expect(world.applied.size).toBe(0);
    expect(world.accounts.find((a) => a.id === "001DEMO000001")!.owner).toBe("Jordan");
  });

  it("approval times out (expires) and the run cancels safely with no write", async () => {
    const spec = await buildSpec();
    // 1-minute approval timeout so the time-skipping env fires it fast.
    spec.failure_policy.approval_timeout_minutes = 1;
    const world = new DemoSalesforceWorld();
    const { result } = await withWorker(world, "q-exp", () =>
      env.client.workflow.execute(agentRunWorkflow, {
        workflowId: `wf-${uuidv7()}`,
        taskQueue: "q-exp",
        args: [{ run: runInput(spec, "supervised", "idem-exp-1"), spec }],
      }),
    );
    expect((result as AgentRunWorkflowResult).status).toBe("expired");
    expect(world.applied.size).toBe(0);
  });
});
