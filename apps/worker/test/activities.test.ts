import { describe, expect, it, vi } from "vitest";
import {
  uuidv7,
  executionReceiptSchema,
  type AgentRunInput,
  type AgentSpec,
} from "@maman/contracts";
import { compileAgentSpec, DemoSalesforceWorld, DEMO_ACCOUNT_LIST } from "@maman/agent-runtime";
import { DEFAULT_ORG_POLICY } from "@maman/policy-engine";
import { createActivities, type PersistenceSink } from "../src/activities.js";

async function spec(): Promise<AgentSpec> {
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
    desired_outcome: "reconcile",
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

function run(s: AgentSpec, mode: AgentRunInput["mode"]): AgentRunInput {
  return {
    run_id: uuidv7(),
    agent_id: s.agent_id,
    agent_version_id: s.version_id,
    organization_id: s.organization_id,
    owner_user_id: s.owner_user_id,
    mode,
    trigger: { type: "manual", idempotency_key: uuidv7() },
    // The reconciliation spec declares `account_csv` required. This was `{}`,
    // and the run succeeded anyway because `local.parse_csv` ignored its inputs
    // and returned the bundled fixture — so the durable path was reconciling
    // sample rows too. Naming the sample makes the choice explicit.
    agent_inputs: { account_csv: DEMO_ACCOUNT_LIST },
    policy_version_id: uuidv7(),
    requested_at: "2026-07-17T18:00:00.000Z",
  };
}

const noopSink = (): PersistenceSink => ({
  runStatus: vi.fn(),
  stepResult: vi.fn(),
  approvalRequested: vi.fn(),
  receipt: vi.fn(),
});

describe("worker activities", () => {
  it("read steps flow outputs forward and propose produces the 4-change diff", async () => {
    const world = new DemoSalesforceWorld();
    const acts = createActivities({ world, sink: noopSink(), now: () => new Date() });
    const s = await spec();
    const r = run(s, "shadow");
    let outputs: Record<string, unknown> = {};
    for (const step of s.steps) {
      if (step.mode === "write") continue;
      const result = await acts.executeReadStep({
        spec: s,
        step_id: step.step_id,
        outputs,
        run: r,
      });
      expect(result.status).not.toBe("failed");
      outputs = result.outputs;
      if (result.status === "proposed") expect(result.change_count).toBe(4);
    }
  });

  it("createApproval stores only a token hash, never the token", async () => {
    const sink = noopSink();
    const acts = createActivities({
      world: new DemoSalesforceWorld(),
      sink,
      now: () => new Date("2026-07-17T18:00:00Z"),
    });
    const s = await spec();
    await acts.createApproval({
      run: run(s, "supervised"),
      step_id: "apply-updates",
      diff_sha256: "abc",
      timeout_minutes: 1440,
    });
    const call = (sink.approvalRequested as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.tokenSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(call).not.toHaveProperty("token");
  });

  it("finalizeRun writes a schema-valid receipt; shadow reports zero writes", async () => {
    const sink = noopSink();
    const acts = createActivities({
      world: new DemoSalesforceWorld(),
      sink,
      now: () => new Date("2026-07-17T18:05:00Z"),
    });
    const s = await spec();
    const r = run(s, "shadow");
    // seed a proposed diff into run state via a read pass
    let outputs: Record<string, unknown> = {};
    for (const step of s.steps) {
      if (step.mode === "write") continue;
      outputs = (await acts.executeReadStep({ spec: s, step_id: step.step_id, outputs, run: r }))
        .outputs;
    }
    await acts.finalizeRun({
      run: r,
      spec: s,
      status: "completed",
      steps: s.steps.map((step, i) => ({
        step_id: step.step_id,
        step_order: i + 1,
        capability_id: step.capability_id,
        mode: step.mode,
        status: step.mode === "write" ? "skipped" : "completed",
      })),
      intervention_ms: 0,
      total_cost_usd: 0,
      model_cost_usd: 0.05,
    });
    const receipt = (sink.receipt as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(() => executionReceiptSchema.parse(receipt)).not.toThrow();
    expect(receipt.totals.writes_completed).toBe(0);
    expect(receipt.roi.net_time_saved_ms).toBe(0);
    // The compile model cost appears on the receipt's model cost line.
    expect(receipt.totals.model_cost_usd).toBe(0.05);
    expect(receipt.totals.total_cost_usd).toBe(0.05);
  });

  it("policy re-evaluation denies an over-budget spec", async () => {
    const acts = createActivities({
      world: new DemoSalesforceWorld(),
      sink: noopSink(),
      now: () => new Date(),
    });
    const s = await spec();
    const overBudget = { ...s, budgets: { ...s.budgets, max_records_written: 999 } };
    const decision = await acts.evaluateRunPolicy({
      spec: overBudget,
      policy_version_id: uuidv7(),
    });
    expect(decision.decision).toBe("deny");
  });
});
