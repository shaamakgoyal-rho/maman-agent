import { beforeEach, describe, expect, it } from "vitest";
import { uuidv7, type AgentSpec } from "@maman/contracts";
import { EXPECTED_DEMO_CHANGES } from "@maman/demo-fixtures";
import { DEFAULT_ORG_POLICY } from "@maman/policy-engine";
import {
  compileAgentSpec,
  demoAdapterRegistry,
  DemoSalesforceWorld,
  DEMO_ACCOUNT_LIST,
  diffSha256,
  executeStep,
  PermanentAdapterError,
  type CapabilityContext,
  type ProposedDiff,
  type RunState,
} from "../src/index.js";

/**
 * The account list these runs reconcile, stated rather than assumed.
 *
 * These tests used to pass `agentInputs: {}` against a spec that declares
 * `account_csv` REQUIRED, and passed — because `local.parse_csv` took no
 * parameters and returned the bundled fixture regardless. Ten tests were
 * exercising a run whose required input nothing had supplied.
 */
const DEMO_INPUTS = { account_csv: DEMO_ACCOUNT_LIST };

/**
 * Drives the compiled reconciliation spec through the demo adapters — the
 * exact §24 journey: shadow diff, approval binding, idempotent write, verify.
 */

async function compiledSpec(): Promise<AgentSpec> {
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

type RunOutcome = {
  diff: ProposedDiff;
  diffSha: string;
  state: RunState;
  writeResult?: { kind: string; verified?: boolean; idempotency_key?: string };
};

async function runThroughProposal(
  world: DemoSalesforceWorld,
  ctx: CapabilityContext,
): Promise<RunOutcome> {
  const spec = await compiledSpec();
  const registry = demoAdapterRegistry(world);
  const state: RunState = { outputs: {} };
  let diff: ProposedDiff | null = null;
  let diffSha = "";

  for (const step of spec.steps) {
    if (step.mode === "write") break; // stop before the approval gate
    const adapter = registry.get(step.capability_id)!;
    const result = await executeStep({ spec, step, state, agentInputs: DEMO_INPUTS, ctx, adapter });
    if (result.kind === "proposed") {
      diff = result.diff;
      diffSha = result.diff_sha256;
    }
  }
  return { diff: diff!, diffSha, state };
}

let world: DemoSalesforceWorld;
const ctx = (mode: CapabilityContext["mode"]): CapabilityContext => ({
  run_id: "00000000-0000-7000-8000-00000000r001",
  organization_id: "org",
  owner_user_id: "user",
  mode,
});

beforeEach(() => {
  world = new DemoSalesforceWorld();
});

describe("expected shadow diff (spec §24)", () => {
  it("ten rows → seven confident, two ambiguous, one missing, four changes across three accounts", async () => {
    const { diff } = await runThroughProposal(world, ctx("shadow"));
    expect(diff.summary).toEqual({
      input_rows: 10,
      confident_matches: 7,
      ambiguous_skipped: 2,
      missing: 1,
      change_count: 4,
      accounts_affected: 3,
    });
    expect(diff.changes).toEqual(EXPECTED_DEMO_CHANGES);
  });

  it("shadow runs perform ZERO writes", async () => {
    const spec = await compiledSpec();
    const registry = demoAdapterRegistry(world);
    const state: RunState = { outputs: {} };
    for (const step of spec.steps) {
      const adapter = registry.get(step.capability_id)!;
      const result = await executeStep({
        spec,
        step,
        state,
        agentInputs: DEMO_INPUTS,
        ctx: ctx("shadow"),
        adapter,
        // even if someone passes an approved diff, shadow must skip
        approvedDiff: {
          summary: {
            input_rows: 0,
            confident_matches: 0,
            ambiguous_skipped: 0,
            missing: 0,
            change_count: 0,
            accounts_affected: 0,
          },
          changes: [],
        },
        approvedDiffSha: "x",
      });
      if (step.mode === "write") expect(result.kind).toBe("skipped_shadow_write");
    }
    expect(world.applied.size).toBe(0);
    // Salesforce org untouched
    expect(world.accounts.find((a) => a.id === "001DEMO000001")!.owner).toBe("Jordan");
  });

  it("the proposed diff is deterministic (same hash every run)", async () => {
    const first = await runThroughProposal(new DemoSalesforceWorld(), ctx("shadow"));
    const second = await runThroughProposal(new DemoSalesforceWorld(), ctx("shadow"));
    expect(first.diffSha).toBe(second.diffSha);
  });
});

describe("supervised write path (spec §24)", () => {
  // One immutable spec version per test run — idempotency keys derive from it.
  let sharedSpec: AgentSpec | null = null;
  async function getSpec(): Promise<AgentSpec> {
    sharedSpec ??= await compiledSpec();
    return sharedSpec;
  }

  async function applyWrite(outcome: RunOutcome, diffShaOverride?: string) {
    const spec = await getSpec();
    const registry = demoAdapterRegistry(world);
    const writeStep = spec.steps.find((s) => s.mode === "write")!;
    return executeStep({
      spec,
      step: writeStep,
      state: outcome.state,
      agentInputs: DEMO_INPUTS,
      ctx: ctx("supervised"),
      adapter: registry.get(writeStep.capability_id)!,
      approvedDiff: outcome.diff,
      approvedDiffSha: diffShaOverride ?? outcome.diffSha,
    });
  }

  it("the approved four-change diff applies exactly once and verifies", async () => {
    const outcome = await runThroughProposal(world, ctx("supervised"));
    const result = await applyWrite(outcome);
    expect(result.kind).toBe("written");
    if (result.kind !== "written") return;
    expect(result.verified).toBe(true);
    expect(result.verify_detail).toContain("4/4");
    // The fake Salesforce actually changed
    expect(world.accounts.find((a) => a.id === "001DEMO000001")!.owner).toBe("Alex");
    expect(world.accounts.find((a) => a.id === "001DEMO000001")!.employee_count).toBe(250);
    expect(world.accounts.find((a) => a.id === "001DEMO000002")!.website).toBe(
      "https://initech.example",
    );
    expect(world.accounts.find((a) => a.id === "001DEMO000004")!.segment).toBe("SMB");
  });

  it("a repeated write with the same idempotency key applies nothing new", async () => {
    const outcome = await runThroughProposal(world, ctx("supervised"));
    const first = await applyWrite(outcome);
    const second = await applyWrite(outcome);
    if (first.kind !== "written" || second.kind !== "written") throw new Error("expected writes");
    expect(second.output).toEqual(first.output);
    expect(world.applied.size).toBe(1); // one accepted key, one application
  });

  it("a changed diff hash invalidates the approval (write refuses)", async () => {
    const outcome = await runThroughProposal(world, ctx("supervised"));
    await expect(applyWrite(outcome, "tampered".padEnd(64, "0"))).rejects.toThrow(
      /diff hash mismatch/,
    );
    expect(world.applied.size).toBe(0);
  });

  it("a write without an approved diff can never execute", async () => {
    const spec = await compiledSpec();
    const registry = demoAdapterRegistry(world);
    const writeStep = spec.steps.find((s) => s.mode === "write")!;
    await expect(
      executeStep({
        spec,
        step: writeStep,
        state: { outputs: {} },
        agentInputs: DEMO_INPUTS,
        ctx: ctx("supervised"),
        adapter: registry.get(writeStep.capability_id)!,
      }),
    ).rejects.toThrow(/without an approved diff/);
  });
});

describe("fault injection (spec §15 demo adapter requirements)", () => {
  it("transient failures are retried within the step's retry budget", async () => {
    world.faults.transient_failures = 2; // query retries: 3 attempts allowed
    const { diff } = await runThroughProposal(world, ctx("shadow"));
    expect(diff.summary.change_count).toBe(4);
  });

  it("permanent failures are never retried", async () => {
    world.faults.permanent_failure = true;
    await expect(runThroughProposal(world, ctx("shadow"))).rejects.toThrow(PermanentAdapterError);
    // exactly one query attempt — no retry storm
    expect(world.requests.filter((r) => r.capability === "salesforce.query_records").length).toBe(
      1,
    );
  });

  it("rate limiting surfaces as retry-safe and eventually exhausts", async () => {
    world.faults.rate_limited = true;
    await expect(runThroughProposal(world, ctx("shadow"))).rejects.toThrow(/rate limited/);
    expect(
      world.requests.filter((r) => r.capability === "salesforce.query_records").length,
    ).toBeGreaterThan(1);
  });

  it("records request assertions", async () => {
    await runThroughProposal(world, ctx("shadow"));
    const capabilities = world.requests.map((r) => r.capability);
    expect(capabilities).toContain("salesforce.query_records");
    expect(capabilities).toContain("salesforce.propose_field_updates");
    expect(capabilities).not.toContain("salesforce.update_fields");
  });
});

describe("diff hashing", () => {
  it("is stable and content-sensitive", () => {
    const diff = {
      summary: {
        input_rows: 1,
        confident_matches: 1,
        ambiguous_skipped: 0,
        missing: 0,
        change_count: 0,
        accounts_affected: 0,
      },
      changes: [],
    };
    expect(diffSha256(diff)).toBe(diffSha256(structuredClone(diff)));
    expect(diffSha256(diff)).not.toBe(diffSha256({ ...diff, changes: [{ x: 1 }] }));
  });
});
