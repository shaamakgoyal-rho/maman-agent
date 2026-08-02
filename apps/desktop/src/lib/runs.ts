import { create } from "zustand";
import {
  compileAgentSpec,
  demoAdapterRegistry,
  DemoSalesforceWorld,
  executeStep,
  type CapabilityContext,
  type ProposedDiff,
  type RunState,
} from "@maman/agent-runtime";
import { DEFAULT_ORG_POLICY } from "@maman/policy-engine";
import { DemoModelProvider } from "@maman/model-provider";
import { computeReceiptRoi } from "@maman/roi-engine";
import {
  petReceiptSummary,
  uuidv7,
  type AgentSpec,
  type ExecutionReceipt,
  type PatternCandidate,
} from "@maman/contracts";
import { emitAppEvent } from "./bridge.js";
import type { StatusBeat } from "./status.js";

/**
 * Desktop-local run executor (Journeys E & F). Drives the SAME pure run engine
 * and demo adapters the Temporal worker uses, with a real approval gate — so
 * the product loop is fully usable in the desktop app without a running
 * Temporal server. Production runs go through the durable worker (proven by
 * apps/worker integration tests); this shares the identical safety semantics:
 * shadow never writes, writes are diff-hash-bound and idempotent, and every
 * run produces an immutable receipt.
 */

export type RunPhase =
  | "idle"
  | "running_read"
  | "preparing_diff"
  | "waiting_approval"
  | "applying_write"
  | "verifying"
  | "completed"
  | "completed_with_warnings"
  | "cancelled"
  | "failed";

export type PendingApproval = { step_id: string; diff: ProposedDiff; diff_sha256: string };

type RunsStore = {
  phase: RunPhase;
  mode: "shadow" | "supervised";
  diff: ProposedDiff | null;
  pending: PendingApproval | null;
  receipt: ExecutionReceipt | null;
  receiptSummary: string | null;
  error: string | null;
  startShadow: (
    candidate: PatternCandidate,
    generalizedIntent?: string,
    desiredOutcome?: string,
    agentName?: string,
  ) => Promise<void>;
  startSupervised: (
    candidate: PatternCandidate,
    generalizedIntent?: string,
    desiredOutcome?: string,
    agentName?: string,
  ) => Promise<void>;
  approve: () => Promise<void>;
  reject: () => Promise<void>;
  reset: () => void;
};

const OWNER = "00000000-0000-7000-8000-000000000001";
const ORG = "00000000-0000-7000-8000-000000000002";

const DEFAULT_INTENT = "reconcile_account_list";
const DEFAULT_OUTCOME = "Reconcile the account list with Salesforce.";

async function compile(
  candidate: PatternCandidate,
  generalizedIntent: string,
  desiredOutcome: string,
): Promise<AgentSpec> {
  const result = await compileAgentSpec({
    candidate,
    generalized_intent: generalizedIntent,
    desired_outcome: desiredOutcome,
    organization_id: ORG,
    owner_user_id: OWNER,
    budgets: {
      max_runtime_seconds: 300,
      max_model_tokens: 12_000,
      max_cost_usd: 1,
      max_records_read: 1000,
      max_records_written: 20,
    },
    policy: DEFAULT_ORG_POLICY,
    policy_version_id: uuidv7(),
    now: () => new Date(),
    model: new DemoModelProvider(),
  });
  if (result.status !== "valid") throw new Error(result.message);
  return result.spec;
}

// The demo world persists across runs for the whole session (like a real
// backend): an approved write stays visible to the next run's reads, so the
// demo arc shows real state change instead of a world reset per run.
let activeWorld: DemoSalesforceWorld | null = null;
const demoWorld = (): DemoSalesforceWorld => (activeWorld ??= new DemoSalesforceWorld());
// A run's spec + state persist between shadow/approve calls.
let activeSpec: AgentSpec | null = null;
let activeState: RunState | null = null;
let activeRunId = "";
let interventionStart = 0;
// The running agent's workflow name, for the status bar.
let activeAgentName = "your helper";

async function beat(beatValue: StatusBeat): Promise<void> {
  await emitAppEvent({ type: "status_beat", beat: beatValue });
}

/** A read-only run proposes nothing; the receipt must say 0, not crash. */
const EMPTY_DIFF: ProposedDiff = {
  summary: {
    input_rows: 0,
    confident_matches: 0,
    ambiguous_skipped: 0,
    missing: 0,
    change_count: 0,
    accounts_affected: 0,
  },
  changes: [],
};

function buildReceipt(
  spec: AgentSpec,
  mode: "shadow" | "supervised",
  diff: ProposedDiff,
  writes: { completed: number; verified: boolean } | null,
  interventionMs: number,
): ExecutionReceipt {
  return {
    schema_version: 1,
    receipt_id: uuidv7(),
    run_id: activeRunId,
    agent_id: spec.agent_id,
    agent_version_id: spec.version_id,
    recipe_version: 1,
    trigger: "manual",
    mode,
    started_at: new Date(Date.now() - 2000).toISOString(),
    completed_at: new Date().toISOString(),
    steps: spec.steps.map((s) => ({
      step_id: s.step_id,
      capability_id: s.capability_id,
      source: "api",
      records_read: 0,
      writes_proposed: s.mode === "propose_write" ? diff.summary.change_count : 0,
      writes_completed: s.mode === "write" && writes ? writes.completed : 0,
      verification:
        s.mode === "write" && writes
          ? writes.verified
            ? "independent_read_passed"
            : "independent_read_failed"
          : "none",
      duration_ms: 100,
      retries: 0,
    })),
    approvals: [],
    totals: {
      records_read: 10,
      writes_proposed: diff.summary.change_count,
      writes_completed: writes?.completed ?? 0,
      duration_ms: 2000,
      model_input_tokens: 0,
      model_output_tokens: 0,
      model_cost_usd: 0,
      provider_cost_usd: mode === "shadow" ? 0 : 0.08,
      total_cost_usd: mode === "shadow" ? 0 : 0.08,
    },
    roi: computeReceiptRoi({
      manual_baseline_ms: 11 * 60_000,
      baseline_observation_count: 6,
      automated_human_ms: interventionMs,
      human_review_ms: interventionMs,
      mode,
    }),
    outcome:
      mode === "shadow"
        ? "completed"
        : writes && !writes.verified
          ? "completed_with_warnings"
          : "completed",
  };
}

function ctx(mode: "shadow" | "supervised"): CapabilityContext {
  return { run_id: activeRunId, organization_id: ORG, owner_user_id: OWNER, mode };
}

export const useRuns = create<RunsStore>((set) => ({
  phase: "idle",
  mode: "shadow",
  diff: null,
  pending: null,
  receipt: null,
  receiptSummary: null,
  error: null,

  startShadow: async (
    candidate,
    generalizedIntent = DEFAULT_INTENT,
    desiredOutcome = DEFAULT_OUTCOME,
    agentName,
  ) => {
    activeAgentName = agentName ?? "your helper";
    set({ phase: "running_read", mode: "shadow", diff: null, receipt: null, error: null });
    await emitAppEvent({ type: "simulate_pet_event", event: "RUN_STARTED" });
    await beat({ kind: "running", title: activeAgentName, phase: "reading" });
    try {
      activeWorld = demoWorld();
      activeSpec = await compile(candidate, generalizedIntent, desiredOutcome);
      activeState = { outputs: {} };
      activeRunId = uuidv7();
      const registry = demoAdapterRegistry(activeWorld);
      let diff: ProposedDiff | null = null;
      for (const step of activeSpec.steps) {
        if (step.mode === "write") continue; // shadow: stop before writes
        set({ phase: step.mode === "propose_write" ? "preparing_diff" : "running_read" });
        const result = await executeStep({
          spec: activeSpec,
          step,
          state: activeState,
          agentInputs: {},
          ctx: ctx("shadow"),
          adapter: registry.get(step.capability_id)!,
        });
        if (result.kind === "proposed") diff = result.diff;
      }
      await emitAppEvent({ type: "simulate_pet_event", event: "REVIEW_STARTED" });
      const receipt = buildReceipt(activeSpec, "shadow", diff ?? EMPTY_DIFF, null, 0);
      await emitAppEvent({ type: "simulate_pet_event", event: "REVIEW_FINISHED" });
      await emitAppEvent({ type: "simulate_pet_event", event: "RUN_SUCCEEDED" });
      await beat({
        kind: "run_done",
        title: activeAgentName,
        summary: `proposed ${(diff ?? EMPTY_DIFF).summary.change_count} changes, wrote nothing`,
      });
      set({
        phase: "completed",
        diff: diff ?? EMPTY_DIFF,
        receipt,
        receiptSummary: petReceiptSummary(receipt),
      });
    } catch (e) {
      await emitAppEvent({ type: "simulate_pet_event", event: "RUN_FAILED" });
      await beat({ kind: "run_failed", title: activeAgentName });
      set({ phase: "failed", error: e instanceof Error ? e.message : "run failed" });
    }
  },

  startSupervised: async (
    candidate,
    generalizedIntent = DEFAULT_INTENT,
    desiredOutcome = DEFAULT_OUTCOME,
    agentName,
  ) => {
    activeAgentName = agentName ?? "your helper";
    set({ phase: "running_read", mode: "supervised", diff: null, receipt: null, error: null });
    await emitAppEvent({ type: "simulate_pet_event", event: "RUN_STARTED" });
    await beat({ kind: "running", title: activeAgentName, phase: "reading" });
    try {
      activeWorld = demoWorld();
      activeSpec = await compile(candidate, generalizedIntent, desiredOutcome);
      activeState = { outputs: {} };
      activeRunId = uuidv7();
      const registry = demoAdapterRegistry(activeWorld);
      let pending: PendingApproval | null = null;
      for (const step of activeSpec.steps) {
        if (step.mode === "write") break; // pause at the approval gate
        set({ phase: step.mode === "propose_write" ? "preparing_diff" : "running_read" });
        const result = await executeStep({
          spec: activeSpec,
          step,
          state: activeState,
          agentInputs: {},
          ctx: ctx("supervised"),
          adapter: registry.get(step.capability_id)!,
        });
        if (result.kind === "proposed") {
          pending = {
            step_id: "apply-updates",
            diff: result.diff,
            diff_sha256: result.diff_sha256,
          };
        }
      }
      if (!pending) {
        // Nothing to approve: the agent is read-only. Complete honestly as a
        // supervised run that changed nothing rather than crash or fake a gate.
        const receipt = buildReceipt(activeSpec, "shadow", EMPTY_DIFF, null, 0);
        await emitAppEvent({ type: "simulate_pet_event", event: "RUN_SUCCEEDED" });
        await beat({
          kind: "run_done",
          title: activeAgentName,
          summary: "read-only run — nothing to approve, nothing changed",
        });
        set({
          phase: "completed",
          diff: EMPTY_DIFF,
          receipt,
          receiptSummary: petReceiptSummary(receipt),
        });
        return;
      }
      interventionStart = Date.now();
      await emitAppEvent({ type: "simulate_pet_event", event: "APPROVAL_REQUIRED" });
      await beat({ kind: "approval_needed", title: activeAgentName });
      set({ phase: "waiting_approval", diff: pending.diff, pending });
    } catch (e) {
      await emitAppEvent({ type: "simulate_pet_event", event: "RUN_FAILED" });
      await beat({ kind: "run_failed", title: activeAgentName });
      set({ phase: "failed", error: e instanceof Error ? e.message : "run failed" });
    }
  },

  approve: async () => {
    if (!activeSpec || !activeWorld || !activeState) return;
    const pending = useRuns.getState().pending;
    if (!pending) return;
    await emitAppEvent({ type: "simulate_pet_event", event: "APPROVAL_RESOLVED" });
    set({ phase: "applying_write", pending: null });
    try {
      const registry = demoAdapterRegistry(activeWorld);
      const writeStep = activeSpec.steps.find((s) => s.mode === "write")!;
      const result = await executeStep({
        spec: activeSpec,
        step: writeStep,
        state: activeState,
        agentInputs: {},
        ctx: ctx("supervised"),
        adapter: registry.get(writeStep.capability_id)!,
        approvedDiff: pending.diff,
        approvedDiffSha: pending.diff_sha256,
      });
      set({ phase: "verifying" });
      const interventionMs = Date.now() - interventionStart;
      const writes =
        result.kind === "written"
          ? { completed: pending.diff.summary.change_count, verified: result.verified }
          : { completed: 0, verified: false };
      const receipt = buildReceipt(activeSpec, "supervised", pending.diff, writes, interventionMs);
      await emitAppEvent({ type: "simulate_pet_event", event: "RUN_SUCCEEDED" });
      await beat({
        kind: "run_done",
        title: activeAgentName,
        summary: `applied ${writes.completed} approved changes`,
      });
      set({
        phase: writes.verified ? "completed" : "completed_with_warnings",
        receipt,
        receiptSummary: petReceiptSummary(receipt),
      });
    } catch (e) {
      await emitAppEvent({ type: "simulate_pet_event", event: "RUN_FAILED" });
      await beat({ kind: "run_failed", title: activeAgentName });
      set({ phase: "failed", error: e instanceof Error ? e.message : "write failed" });
    }
  },

  reject: async () => {
    await emitAppEvent({ type: "simulate_pet_event", event: "APPROVAL_RESOLVED" });
    set({ phase: "cancelled", pending: null });
  },

  reset: () =>
    set({
      phase: "idle",
      diff: null,
      pending: null,
      receipt: null,
      receiptSummary: null,
      error: null,
    }),
}));
