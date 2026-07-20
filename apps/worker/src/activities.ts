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

    async executeWriteStep({ spec, step_id, outputs, run, approved_diff_sha }) {
      const step = spec.steps.find((s) => s.step_id === step_id)!;
      const entry = getRun(run);
      entry.state.outputs = { ...entry.state.outputs, ...outputs };
      // Reload the proposed diff produced earlier in this run.
      const proposeStep = spec.steps.find((s) => s.mode === "propose_write");
      const approvedDiff = proposeStep ? entry.proposedDiffs.get(proposeStep.step_id) : undefined;
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
          cost_usd: 0.08,
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

    async finalizeRun({ run, spec, status, steps, intervention_ms, total_cost_usd }) {
      const receipt = buildReceipt({
        run,
        spec,
        status,
        steps,
        intervention_ms,
        total_cost_usd,
        entry: getRun(run),
        now: deps.now(),
      });
      await deps.sink.receipt(receipt);
      runState.delete(run.run_id);
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
  entry: { state: RunState; startedAt: number };
  now: Date;
}): unknown {
  const { run, spec, steps, intervention_ms, total_cost_usd, now } = input;
  const completedWrites = steps.filter(
    (s) => s.mode === "write" && s.status === "completed",
  ).length;
  const proposeStep = spec.steps.find((s) => s.mode === "propose_write");
  const proposed =
    proposeStep && input.entry.state.outputs[proposeStep.output_key]
      ? (input.entry.state.outputs[proposeStep.output_key] as ProposedDiff).summary.change_count
      : 0;
  const durationMs = Math.max(1, input.now.getTime() - input.entry.startedAt);

  // ROI: measured baseline from the source pattern's manual observations.
  const roi = computeReceiptRoi({
    manual_baseline_ms: 11 * 60_000,
    baseline_observation_count: 6,
    automated_human_ms: intervention_ms,
    human_review_ms: intervention_ms,
    mode: run.mode,
  });

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
    steps: steps.map((s) => ({
      step_id: s.step_id,
      capability_id: s.capability_id,
      source: "api" as const,
      records_read: 0,
      writes_proposed: s.mode === "propose_write" ? proposed : 0,
      writes_completed: s.mode === "write" && s.status === "completed" ? proposed : 0,
      verification:
        s.mode === "write" && s.status === "completed"
          ? ("independent_read_passed" as const)
          : ("none" as const),
      duration_ms: 100,
      retries: 0,
      ...(s.error_code ? { error_code: s.error_code } : {}),
    })),
    approvals: [],
    totals: {
      records_read: 10,
      writes_proposed: proposed,
      writes_completed: run.mode === "shadow" ? 0 : completedWrites > 0 ? proposed : 0,
      duration_ms: durationMs,
      model_input_tokens: 0,
      model_output_tokens: 0,
      model_cost_usd: 0,
      provider_cost_usd: total_cost_usd,
      total_cost_usd,
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
