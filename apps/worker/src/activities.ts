import { createHash } from "node:crypto";
import type { AgentRunInput, AgentSpec, RunStepSummary } from "@maman/contracts";
import { executionReceiptSchema, uuidv7 } from "@maman/contracts";
import {
  demoAdapterRegistry,
  executeStep,
  type CapabilityAdapter,
  type CapabilityContext,
  type DemoSalesforceWorld,
  type ProposedDiff,
  type RunState,
  type StepExecution,
} from "@maman/agent-runtime";
import type { RunActivities, StepActivityResult } from "@maman/agent-runtime/workflow";
import { DEFAULT_ORG_POLICY, evaluateSpec } from "@maman/policy-engine";
import { computeReceiptRoi } from "@maman/roi-engine";

/**
 * Worker-side activity implementations. This is where side effects live:
 * capability adapters, policy re-evaluation, persistence, and receipt writing.
 *
 * The demo build uses in-process deterministic adapters and an in-memory
 * persistence sink so the full durable loop runs with zero credentials. Real
 * connector adapters and DB repositories drop in behind the same interface.
 */

export type PersistenceSink = {
  runStatus: (runId: string, status: string) => void | Promise<void>;
  stepResult: (
    runId: string,
    summary: RunStepSummary,
    result: StepActivityResult,
  ) => void | Promise<void>;
  approvalRequested: (input: {
    runId: string;
    stepId: string;
    diffSha: string;
    tokenSha256: string;
    expiresAt: string;
  }) => void | Promise<void>;
  receipt: (receipt: unknown) => void | Promise<void>;
};

export type ActivityDeps = {
  /** Prebuilt capability registry (real mode). Takes precedence over `world`. */
  registry?: Map<string, CapabilityAdapter>;
  /** Demo world used to build the demo registry when `registry` is absent. */
  world?: DemoSalesforceWorld;
  sink: PersistenceSink;
  now: () => Date;
};

/** Per-run world + proposed-diff cache so write steps can reload the diff. */
const runState = new Map<
  string,
  { state: RunState; proposedDiffs: Map<string, ProposedDiff>; startedAt: number }
>();

/**
 * Clears the in-memory run cache — used by chaos tests to simulate a worker
 * process restart (a real restart loses this cache; the write must survive
 * anyway because the workflow carries the approved diff + outputs in history).
 */
export function __resetRunStateForTests(): void {
  runState.clear();
}

function ctxOf(run: AgentRunInput): CapabilityContext {
  return {
    run_id: run.run_id,
    organization_id: run.organization_id,
    owner_user_id: run.owner_user_id,
    mode: run.mode,
  };
}

function getRun(run: AgentRunInput) {
  let entry = runState.get(run.run_id);
  if (!entry) {
    entry = {
      state: { outputs: { ...run.agent_inputs } },
      proposedDiffs: new Map(),
      startedAt: Date.now(),
    };
    runState.set(run.run_id, entry);
  }
  return entry;
}

export function createActivities(deps: ActivityDeps): RunActivities {
  const registry =
    deps.registry ??
    demoAdapterRegistry(
      deps.world ??
        (() => {
          throw new Error("createActivities requires either `registry` or `world`");
        })(),
    );

  return {
    async evaluateRunPolicy({ spec, policy_version_id }) {
      const decision = evaluateSpec(spec, DEFAULT_ORG_POLICY, {
        policy_version_id,
        evaluated_at: deps.now().toISOString(),
      });
      return { decision: decision.decision, reason: decision.reasons[0]?.message ?? "" };
    },

    async executeReadStep({ spec, step_id, outputs, run }) {
      const step = spec.steps.find((s) => s.step_id === step_id)!;
      const entry = getRun(run);
      entry.state.outputs = { ...entry.state.outputs, ...outputs };
      try {
        const result = await runStep(spec, step, entry.state, run, registry);
        if (result.kind === "proposed") {
          entry.proposedDiffs.set(step_id, result.diff);
          return {
            status: "proposed",
            outputs: entry.state.outputs,
            diff_sha256: result.diff_sha256,
            diff: result.diff,
            change_count: result.diff.summary.change_count,
            cost_usd: 0,
          };
        }
        const readOutput = result.kind === "read" ? result.output : null;
        return {
          status: "completed",
          outputs: entry.state.outputs,
          records_read: Array.isArray(readOutput) ? readOutput.length : 0,
          cost_usd: 0,
        };
      } catch (e) {
        return {
          status: "failed",
          outputs: entry.state.outputs,
          error_code: e instanceof Error ? e.message : "step_failed",
          error_retry_safe: false,
        };
      }
    },

    async executeWriteStep({ spec, step_id, outputs, run, approved_diff_sha, approved_diff }) {
      const step = spec.steps.find((s) => s.step_id === step_id)!;
      const entry = getRun(run);
      entry.state.outputs = { ...entry.state.outputs, ...outputs };
      // The workflow carries the approved diff through history, so the write is
      // reconstructable after a worker restart. Fall back to the in-memory cache
      // only if the workflow didn't supply it (older histories).
      const proposeStep = spec.steps.find((s) => s.mode === "propose_write");
      const approvedDiff =
        (approved_diff as ProposedDiff | undefined) ??
        (proposeStep ? entry.proposedDiffs.get(proposeStep.step_id) : undefined);
      if (!approvedDiff) {
        return { status: "failed", outputs: entry.state.outputs, error_code: "no_proposed_diff" };
      }
      try {
        const result = await executeStep({
          spec,
          step,
          state: entry.state,
          agentInputs: run.agent_inputs,
          ctx: ctxOf(run),
          adapter: registry.get(step.capability_id)!,
          approvedDiff,
          approvedDiffSha: approved_diff_sha,
        });
        if (result.kind !== "written") {
          return {
            status: "failed",
            outputs: entry.state.outputs,
            error_code: "write_not_applied",
          };
        }
        return {
          status: "completed",
          outputs: entry.state.outputs,
          verified: result.verified,
          verify_detail: result.verify_detail,
          idempotency_key: result.idempotency_key,
          change_count: approvedDiff.summary.change_count,
          // 0, not 0.08. This accumulates into the workflow's `totalCost` and
          // lands on the receipt as `provider_cost_usd` — so a made-up figure
          // here becomes a cost the user is told they incurred, and is then
          // subtracted from ROI. Salesforce API calls are not billed per write;
          // when a provider genuinely does charge, the adapter is where that
          // number has to come from.
          cost_usd: 0,
        };
      } catch (e) {
        return {
          status: "failed",
          outputs: entry.state.outputs,
          error_code: e instanceof Error ? e.message : "write_failed",
        };
      }
    },

    async createApproval({ run, step_id, diff_sha256, timeout_minutes }) {
      // One-time token: only its SHA-256 hash is persisted.
      const token = uuidv7() + uuidv7();
      const tokenSha256 = createHash("sha256").update(token).digest("hex");
      const expiresAt = new Date(deps.now().getTime() + timeout_minutes * 60_000).toISOString();
      await deps.sink.approvalRequested({
        runId: run.run_id,
        stepId: step_id,
        diffSha: diff_sha256,
        tokenSha256,
        expiresAt,
      });
    },

    async recordRunStatus({ run, status }) {
      await deps.sink.runStatus(run.run_id, status);
    },

    async recordStepResult({ run, step_id, step_order, capability_id, mode, result }) {
      const summary: RunStepSummary = {
        step_id,
        step_order,
        capability_id,
        mode: mode as RunStepSummary["mode"],
        status:
          result.status === "completed"
            ? "completed"
            : result.status === "failed"
              ? "failed"
              : result.status === "skipped_shadow_write"
                ? "skipped"
                : "completed",
        ...(result.diff_sha256 ? { diff_sha256: result.diff_sha256 } : {}),
        ...(result.error_code ? { error_code: result.error_code } : {}),
      };
      await deps.sink.stepResult(run.run_id, summary, result);
    },

    async finalizeRun({
      run,
      spec,
      status,
      steps,
      intervention_ms,
      total_cost_usd,
      model_cost_usd,
    }) {
      const receipt = buildReceipt({
        run,
        spec,
        status,
        steps,
        intervention_ms,
        total_cost_usd,
        model_cost_usd,
        entry: getRun(run),
        now: deps.now(),
      });
      await deps.sink.receipt(receipt);
      runState.delete(run.run_id);
      // Returned so the workflow can surface it to `get_receipt` queries.
      return receipt;
    },
  };
}

async function runStep(
  spec: AgentSpec,
  step: AgentSpec["steps"][number],
  state: RunState,
  run: AgentRunInput,
  registry: ReturnType<typeof demoAdapterRegistry>,
): Promise<StepExecution> {
  return executeStep({
    spec,
    step,
    state,
    agentInputs: run.agent_inputs,
    ctx: ctxOf(run),
    adapter: registry.get(step.capability_id)!,
  });
}

function buildReceipt(input: {
  run: AgentRunInput;
  spec: AgentSpec;
  status: string;
  steps: RunStepSummary[];
  intervention_ms: number;
  total_cost_usd: number;
  model_cost_usd: number;
  entry: { state: RunState; startedAt: number };
  now: Date;
}): unknown {
  const { run, spec, steps, intervention_ms, total_cost_usd, model_cost_usd, now } = input;
  const completedWrites = steps.filter(
    (s) => s.mode === "write" && s.status === "completed",
  ).length;
  const proposeStep = spec.steps.find((s) => s.mode === "propose_write");
  const proposed =
    proposeStep && input.entry.state.outputs[proposeStep.output_key]
      ? (input.entry.state.outputs[proposeStep.output_key] as ProposedDiff).summary.change_count
      : 0;
  const durationMs = Math.max(1, input.now.getTime() - input.entry.startedAt);

  // ROI: NO BASELINE IS AVAILABLE HERE, and the receipt says so.
  //
  // The comment above this used to read "measured baseline from the source
  // pattern's manual observations", which was false — the values were
  // `11 * 60_000` and `6`, both literals. Since 6 clears
  // `MEASURED_BASELINE_MIN_OBSERVATIONS` (3), `computeReceiptRoi` stamped the
  // savings "measured" and `petReceiptSummary` reported "Saved approximately 11
  // minutes" for every run the worker ever finalized.
  //
  // The real baseline lives on the pattern candidate (`median_duration_ms`,
  // `occurrence_count`), which the device has and `AgentRunInput` does not
  // carry. Zeroes drop provenance to "estimated", which is the truthful answer
  // until those observations are threaded through the run input — a contract
  // change tracked in BUILD_STATUS rather than papered over with a plausible
  // number.
  const roi = computeReceiptRoi({
    manual_baseline_ms: 0,
    baseline_observation_count: 0,
    automated_human_ms: intervention_ms,
    human_review_ms: intervention_ms,
    mode: run.mode,
  });

  const receiptSteps = steps.map((s) => ({
    step_id: s.step_id,
    capability_id: s.capability_id,
    source: "api" as const,
    // 0 because nothing here measured it, not because nothing was read. The
    // activity DOES count records (`executeReadStep` returns `records_read`),
    // but `RunStepSummary` has no field to carry it back, so the count is
    // discarded at the workflow boundary. Threading it is an additive
    // contract change, noted in BUILD_STATUS; inventing a number in the
    // meantime is what this whole change is removing.
    records_read: 0,
    writes_proposed: s.mode === "propose_write" ? proposed : 0,
    writes_completed: s.mode === "write" && s.status === "completed" ? proposed : 0,
    verification:
      s.mode === "write" && s.status === "completed"
        ? ("independent_read_passed" as const)
        : ("none" as const),
    // Per-step timing is not measured on this path either. `RunStepSummary`
    // carries optional `started_at`/`completed_at` that nothing populates.
    // The RUN's total below is real (`durationMs`), so the receipt reports
    // the window it can prove and 0 for the parts it cannot — rather than
    // 100ms per step, which summed to a number no clock produced.
    duration_ms: 0,
    retries: 0,
    ...(s.error_code ? { error_code: s.error_code } : {}),
  }));

  const receipt = {
    schema_version: 1 as const,
    receipt_id: uuidv7(),
    run_id: run.run_id,
    agent_id: run.agent_id,
    agent_version_id: run.agent_version_id,
    recipe_version: 1,
    trigger: run.trigger.type,
    mode: run.mode === "active" ? ("autonomous" as const) : run.mode,
    started_at: new Date(input.entry.startedAt).toISOString(),
    completed_at: now.toISOString(),
    steps: receiptSteps,
    approvals: [],
    totals: {
      // Sum of the steps above, so the total and its parts cannot disagree.
      // This was the literal `10`, sitting over per-step zeroes.
      records_read: receiptSteps.reduce((n, s) => n + s.records_read, 0),
      writes_proposed: proposed,
      writes_completed: run.mode === "shadow" ? 0 : completedWrites > 0 ? proposed : 0,
      duration_ms: durationMs,
      model_input_tokens: 0,
      model_output_tokens: 0,
      // The run itself is deterministic (no model at run time); this line
      // carries the one-time model cost of compiling the version it ran.
      model_cost_usd: model_cost_usd,
      provider_cost_usd: total_cost_usd,
      total_cost_usd: total_cost_usd + model_cost_usd,
    },
    roi,
    outcome:
      input.status === "completed"
        ? ("completed" as const)
        : input.status === "completed_with_warnings"
          ? ("completed_with_warnings" as const)
          : input.status === "cancelled" || input.status === "expired"
            ? ("cancelled" as const)
            : ("failed" as const),
  };
  return executionReceiptSchema.parse(receipt);
}
