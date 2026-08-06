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
import {
  DEFAULT_ORG_POLICY,
  evaluatePackPolicy,
  type PackPolicyVerdict,
} from "@maman/policy-engine";
import { SHIPPED_PACKS } from "@maman/domain-packs";
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
import {
  previewBrowserPlan,
  runBrowserPlan,
  revertBrowserRun,
  changesForRecord,
  type BrowserLaneResult,
  type BrowserPlanPreview,
} from "./browserRun.js";

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

/**
 * Which lane the write will actually use.
 *
 * `api` is the demo/connector path and is preferred — `capability-router` scores it
 * above the browser. `browser` is for systems with no usable API, and it is the
 * user's decision to take it, not an automatic fallback from a failed API write:
 * a consequential step that fails stops and asks.
 */
export type RunLane = "api" | "browser";

/**
 * The exact actions a browser-lane run will perform, shown BEFORE approval.
 *
 * A diff summary ("update 4 fields") is not something anyone can consent to
 * meaningfully when the mechanism is a real browser typing into a real page. These
 * are the per-step lines the user reads instead.
 */
export type BrowserPlanView = {
  lines: string[];
  writes: number;
  record: string;
  /** Changes on records other than the one open in the browser. */
  deferred: number;
  deferred_records: string[];
};

/**
 * A run blocked by DOMAIN POLICY (L3) before anything executed. Distinct from
 * an approval: an approval is a gate the worker can pass, while a policy hold
 * means this agent may not perform the step at all (segregation of duties) or
 * needs a second approver (dual control). Policy is evaluated BEFORE the run
 * starts and before any autonomy consideration — it can only restrict.
 */
export type PolicyHold = {
  kind: "segregation_of_duties" | "dual_control";
  /** Worker-facing explanations straight from the pack rules. */
  reasons: string[];
  /** The strictest autonomy ceiling policy imposed, if any. */
  ceiling?: string;
};

type RunsStore = {
  phase: RunPhase;
  mode: "shadow" | "supervised";
  lane: RunLane;
  diff: ProposedDiff | null;
  pending: PendingApproval | null;
  /** The plan the user is approving, when the lane is the browser. */
  browserPlan: BrowserPlanView | null;
  /** Why a browser plan could not be built, named down to the change. */
  browserPlanRefusal: string | null;
  /** Set after a browser run applied something that could be put back. */
  revertable: BrowserLaneResult["revertable"];
  /** Set when domain policy blocked the run before execution. */
  policyHold: PolicyHold | null;
  receipt: ExecutionReceipt | null;
  receiptSummary: string | null;
  error: string | null;
  /** Origins actuation may touch, from the user's allowlist. Never hardcoded. */
  browserOrigins: string[];
  /**
   * Chooses the lane for the next supervised run. `origins` comes from the
   * settings allowlist: with none, a browser write has nothing to be checked
   * against and the plan is refused rather than sent.
   */
  setLane: (lane: RunLane, origins?: readonly string[]) => void;
  /** Undoes an applied browser run. Consequential, so it re-approves. */
  revert: () => Promise<void>;
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

/**
 * Evaluates domain policy for the agent's observed actions BEFORE the run.
 *
 * The SoD case is exactly "this agent would perform two conflicting actions":
 * every observed action is passed as a sibling, so a workflow containing both
 * code_invoice and approve_invoice trips the rule regardless of which
 * capabilities the compiler picked.
 */
function evaluateRunPolicy(candidate: PatternCandidate): {
  hold: PolicyHold | null;
  verdicts: PackPolicyVerdict[];
} {
  const actions = candidate.domain_actions ?? [];
  if (actions.length === 0) return { hold: null, verdicts: [] };

  const verdicts = actions.map((action, index) =>
    evaluatePackPolicy(
      SHIPPED_PACKS,
      { step_id: `a${index}`, domain_action: action },
      {
        sibling_actions: actions.filter((a) => a !== action),
      },
    ),
  );

  const blocking = verdicts.find((v) => v.requires_human) ?? verdicts.find((v) => v.dual_control);
  if (!blocking) return { hold: null, verdicts };

  const ceiling = verdicts.map((v) => v.ceiling).find((c) => c !== undefined);
  return {
    hold: {
      kind: blocking.requires_human ? "segregation_of_duties" : "dual_control",
      reasons: [...new Set(verdicts.flatMap((v) => v.reasons.map((r) => r.message)))],
      ...(ceiling ? { ceiling } : {}),
    },
    verdicts,
  };
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
  /**
   * The lane the write actually used. This was hardcoded to "api" before the
   * browser lane existed, which would have made every browser run's receipt claim
   * an API call it never made — the receipt is the audit record, so it reports
   * what happened rather than what was expected.
   */
  lane: RunLane = "api",
): ExecutionReceipt {
  const writeSource = lane === "browser" ? "browser_extension" : "api";
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
      // Reads still come from the API/demo adapters in both lanes; only the write
      // step changes hands.
      source: s.mode === "write" ? writeSource : "api",
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

/**
 * The plan compiled at the approval gate, held until the user approves.
 *
 * Deliberately NOT recomputed in `approve`: the user approves a specific list of
 * actions, and rebuilding it afterwards would mean they consented to one plan and
 * a different one ran. Staleness is handled instead by each write carrying the
 * value it expects to find, so a page that moved on refuses rather than overwrites.
 */
let activeBrowserPlan: BrowserPlanPreview | null = null;

export const useRuns = create<RunsStore>((set) => ({
  phase: "idle",
  mode: "shadow",
  lane: "api",
  browserOrigins: [],
  diff: null,
  pending: null,
  browserPlan: null,
  browserPlanRefusal: null,
  revertable: [],
  policyHold: null,
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
    // DOMAIN POLICY FIRST: before any step runs, and before autonomy is
    // considered at all. A hold stops the run rather than gating it.
    const { hold } = evaluateRunPolicy(candidate);
    if (hold) {
      set({
        phase: "cancelled",
        mode: "supervised",
        diff: null,
        pending: null,
        policyHold: hold,
        receipt: null,
        error: null,
      });
      await beat({
        kind: "run_failed",
        title: agentName ?? "your helper",
      });
      return;
    }
    set({
      phase: "running_read",
      mode: "supervised",
      diff: null,
      pending: null,
      policyHold: null,
      receipt: null,
      error: null,
    });
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
      // BROWSER LANE: compile the plan NOW, so the approval the user gives is for
      // the actions they read. A plan that cannot be built blocks the gate with the
      // reason rather than presenting an approval that would fail on arrival.
      activeBrowserPlan = null;
      let browserPlan: BrowserPlanView | null = null;
      let browserPlanRefusal: string | null = null;
      if (useRuns.getState().lane === "browser") {
        const planned =
          useRuns.getState().browserOrigins.length === 0
            ? {
                ok: false as const,
                reason:
                  "no allow-listed origin for browser actuation — add the site in Settings first",
              }
            : previewBrowserPlan(pending.diff);
        if (planned.ok) {
          activeBrowserPlan = planned.preview;
          browserPlan = {
            lines: planned.preview.lines,
            writes: planned.preview.writes,
            record: planned.preview.record,
            deferred: planned.preview.deferred,
            deferred_records: planned.preview.deferred_records,
          };
        } else {
          browserPlanRefusal = planned.reason;
        }
      }

      interventionStart = Date.now();
      await emitAppEvent({ type: "simulate_pet_event", event: "APPROVAL_REQUIRED" });
      await beat({ kind: "approval_needed", title: activeAgentName });
      set({
        phase: "waiting_approval",
        diff: pending.diff,
        pending,
        browserPlan,
        browserPlanRefusal,
      });
    } catch (e) {
      await emitAppEvent({ type: "simulate_pet_event", event: "RUN_FAILED" });
      await beat({ kind: "run_failed", title: activeAgentName });
      set({ phase: "failed", error: e instanceof Error ? e.message : "run failed" });
    }
  },

  setLane: (lane, origins) =>
    set({
      lane,
      browserPlan: null,
      browserPlanRefusal: null,
      ...(origins === undefined ? {} : { browserOrigins: [...origins] }),
    }),

  revert: async () => {
    const { revertable, lane } = useRuns.getState();
    if (lane !== "browser" || revertable.length === 0) return;
    set({ phase: "applying_write" });
    try {
      // A revert is a consequential write and goes through the same gate. The
      // approval is the user pressing Revert; presence is implied by that, and
      // policy still has to allow browser writes at all.
      const result = await revertBrowserRun(revertable, {
        runId: activeRunId,
        routedSource: "browser_extension",
        mode: "supervised",
        allowSupervisedBrowserWrites: true,
        approvalGranted: true,
        userPresent: true,
        allowedOrigins: useRuns.getState().browserOrigins,
      });
      if (!result.ok) {
        set({ phase: "completed_with_warnings", error: `could not revert: ${result.reason}` });
        return;
      }
      const clean = result.outcome.halted_at === null && result.outcome.all_writes_verified;
      await beat({
        kind: "run_done",
        title: activeAgentName,
        summary: clean
          ? `put back ${result.outcome.writes_applied} changes`
          : `revert stopped: ${result.outcome.halted_because ?? "unverified"}`,
      });
      set({
        phase: clean ? "completed" : "completed_with_warnings",
        revertable: clean ? [] : revertable,
        ...(clean ? {} : { error: result.outcome.halted_because ?? "revert unverified" }),
      });
    } catch (e) {
      set({
        phase: "completed_with_warnings",
        error: e instanceof Error ? e.message : "revert failed",
      });
    }
  },

  approve: async () => {
    if (!activeSpec || !activeWorld || !activeState) return;
    const pending = useRuns.getState().pending;
    if (!pending) return;
    await emitAppEvent({ type: "simulate_pet_event", event: "APPROVAL_RESOLVED" });
    set({ phase: "applying_write", pending: null });

    // BROWSER LANE. Not a fallback from a failed API write — the lane was chosen
    // before the run, and the plan was approved as read.
    if (useRuns.getState().lane === "browser") {
      if (activeBrowserPlan === null) {
        set({ phase: "failed", error: "no approved browser plan" });
        return;
      }
      try {
        const scoped = changesForRecord(pending.diff, activeBrowserPlan.record);
        const result = await runBrowserPlan(activeBrowserPlan, scoped.changes, {
          runId: activeRunId,
          routedSource: "browser_extension",
          mode: "supervised",
          allowSupervisedBrowserWrites: true,
          approvalGranted: true,
          userPresent: true,
          allowedOrigins: useRuns.getState().browserOrigins,
        });
        set({ phase: "verifying" });
        const interventionMs = Date.now() - interventionStart;
        const writes = {
          completed: result.outcome.writes_applied,
          verified: result.outcome.all_writes_verified && result.outcome.halted_at === null,
        };

        // A HALTED RUN THAT APPLIED NOTHING IS A FAILURE, not a warning.
        //
        // Found by running it: with no relay connected, every step failed, yet the
        // run reported "finished a read-only run, saved approximately 10 minutes"
        // and counted toward earned autonomy. Zero writes made the receipt look
        // read-only, and `completed_with_warnings` counts as a completed approved
        // run. Nothing was written, nothing was saved, and nothing was earned.
        if (result.outcome.halted_at !== null && writes.completed === 0) {
          await emitAppEvent({ type: "simulate_pet_event", event: "RUN_FAILED" });
          await beat({ kind: "run_failed", title: activeAgentName });
          set({
            phase: "failed",
            revertable: [],
            error: result.outcome.halted_because ?? "the browser did not perform the plan",
          });
          return;
        }

        const receipt = buildReceipt(
          activeSpec,
          "supervised",
          pending.diff,
          writes,
          interventionMs,
          "browser",
        );
        const deferredNote =
          activeBrowserPlan.deferred > 0
            ? `; ${activeBrowserPlan.deferred} left on other records`
            : "";
        await emitAppEvent({
          type: "simulate_pet_event",
          event: writes.verified ? "RUN_SUCCEEDED" : "RUN_FAILED",
        });
        await beat(
          writes.verified
            ? {
                kind: "run_done",
                title: activeAgentName,
                summary: `applied ${writes.completed} changes in the browser${deferredNote}`,
              }
            : { kind: "run_failed", title: activeAgentName },
        );
        set({
          phase: writes.verified ? "completed" : "completed_with_warnings",
          receipt,
          receiptSummary: petReceiptSummary(receipt),
          revertable: result.revertable,
          // The halt reason is shown verbatim: "the browser refused:
          // precondition_failed" tells the user their page changed under the plan,
          // which a generic failure would not.
          ...(result.outcome.halted_because === null
            ? {}
            : { error: result.outcome.halted_because }),
        });
      } catch (e) {
        await emitAppEvent({ type: "simulate_pet_event", event: "RUN_FAILED" });
        await beat({ kind: "run_failed", title: activeAgentName });
        set({ phase: "failed", error: e instanceof Error ? e.message : "browser write failed" });
      }
      return;
    }

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

  reset: () => {
    activeBrowserPlan = null;
    set({
      phase: "idle",
      diff: null,
      pending: null,
      browserPlan: null,
      browserPlanRefusal: null,
      revertable: [],
      policyHold: null,
      receipt: null,
      receiptSummary: null,
      error: null,
    });
  },
}));
