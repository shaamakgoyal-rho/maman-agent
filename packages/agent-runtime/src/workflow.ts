import {
  condition,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";
import type { AgentRunInput, AgentSpec, RunStepSummary } from "@maman/contracts";

/**
 * agentRunWorkflow — durable execution (spec §16).
 *
 * This module runs inside the Temporal workflow sandbox: no Node APIs, no
 * adapters, no crypto. All side effects live in activities; the workflow owns
 * ordering, approval waits, timeouts, budgets, and state for queries.
 */

// ---- activity interface (implemented in apps/worker) ----

export type StepActivityResult = {
  status: "completed" | "proposed" | "skipped_shadow_write" | "failed";
  outputs: Record<string, unknown>;
  diff_sha256?: string;
  diff?: unknown;
  change_count?: number;
  verified?: boolean;
  verify_detail?: string;
  idempotency_key?: string;
  error_code?: string;
  error_retry_safe?: boolean;
  cost_usd?: number;
  records_read?: number;
};

export interface RunActivities {
  /** Re-evaluates org policy against the immutable spec before execution. */
  evaluateRunPolicy(input: {
    spec: AgentSpec;
    policy_version_id: string;
  }): Promise<{ decision: "allow" | "require_approval" | "deny"; reason: string }>;
  /** Executes one read/propose step (safe retries live at the activity layer). */
  executeReadStep(input: {
    spec: AgentSpec;
    step_id: string;
    outputs: Record<string, unknown>;
    run: AgentRunInput;
  }): Promise<StepActivityResult>;
  /** Executes an approved write exactly once (idempotency enforced below). */
  executeWriteStep(input: {
    spec: AgentSpec;
    step_id: string;
    outputs: Record<string, unknown>;
    run: AgentRunInput;
    approved_diff_sha: string;
  }): Promise<StepActivityResult>;
  /** Persists the approval request (one-time token minted server-side). */
  createApproval(input: {
    run: AgentRunInput;
    step_id: string;
    diff_sha256: string;
    timeout_minutes: number;
  }): Promise<void>;
  recordRunStatus(input: { run: AgentRunInput; status: string }): Promise<void>;
  recordStepResult(input: {
    run: AgentRunInput;
    step_id: string;
    step_order: number;
    capability_id: string;
    mode: string;
    result: StepActivityResult;
  }): Promise<void>;
  /** Builds + persists the immutable execution receipt and final run row. */
  finalizeRun(input: {
    run: AgentRunInput;
    spec: AgentSpec;
    status: string;
    steps: RunStepSummary[];
    intervention_ms: number;
    total_cost_usd: number;
    /** One-time model cost of compiling the running version (receipt line). */
    model_cost_usd: number;
  }): Promise<void>;
}

// Reads and safe operations: exponential retry 1s → 5s → 30s, three attempts.
const readActivities = proxyActivities<RunActivities>({
  startToCloseTimeout: "2 minutes",
  retry: {
    initialInterval: "1s",
    backoffCoefficient: 5,
    maximumInterval: "30s",
    maximumAttempts: 3,
  },
});

// Writes: exactly one attempt — never auto-retried by Temporal.
const writeActivities = proxyActivities<RunActivities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 1 },
});

// Bookkeeping: safe to retry.
const bookkeeping = proxyActivities<RunActivities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 5, initialInterval: "1s" },
});

// ---- signals and queries ----

export type ApproveStepPayload = {
  step_id: string;
  diff_hash: string;
  approver_user_id: string;
};
export type RejectStepPayload = { step_id: string; reason: string };
export type CancelRunPayload = { actor_user_id: string; reason: string };

export const approveStepSignal = defineSignal<[ApproveStepPayload]>("approve_step");
export const rejectStepSignal = defineSignal<[RejectStepPayload]>("reject_step");
export const cancelRunSignal = defineSignal<[CancelRunPayload]>("cancel_run");

export const getStatusQuery = defineQuery<string>("get_status");
export const getPendingApprovalQuery = defineQuery<{
  step_id: string;
  diff_sha256: string;
} | null>("get_pending_approval");
export const getCostQuery = defineQuery<{ total_cost_usd: number }>("get_cost");
export const getStepSummariesQuery = defineQuery<RunStepSummary[]>("get_step_summaries");

export type AgentRunWorkflowInput = {
  run: AgentRunInput;
  /** Immutable spec version snapshot (loaded by the API before start). */
  spec: AgentSpec;
  /** Model cost of compiling this version, attributed to the run's receipt. */
  model_cost_usd?: number;
};

export type AgentRunWorkflowResult = {
  status:
    "completed" | "completed_with_warnings" | "failed" | "cancelled" | "expired" | "policy_blocked";
  proposed_changes: number;
  completed_writes: number;
  total_cost_usd: number;
};

export async function agentRunWorkflow(
  input: AgentRunWorkflowInput,
): Promise<AgentRunWorkflowResult> {
  const { run, spec } = input;

  let status = "validating";
  let pendingApproval: { step_id: string; diff_sha256: string } | null = null;
  let approval: ApproveStepPayload | null = null;
  let rejection: RejectStepPayload | null = null;
  let cancellation: CancelRunPayload | null = null;
  let totalCost = 0;
  let interventionMs = 0;
  const stepSummaries: RunStepSummary[] = [];
  let outputs: Record<string, unknown> = { ...run.agent_inputs };
  let proposedChanges = 0;
  let completedWrites = 0;
  let warnings = false;

  setHandler(approveStepSignal, (payload) => {
    // Approval binding: must match the pending step AND its diff hash.
    if (
      pendingApproval &&
      payload.step_id === pendingApproval.step_id &&
      payload.diff_hash === pendingApproval.diff_sha256
    ) {
      approval = payload;
    }
  });
  setHandler(rejectStepSignal, (payload) => {
    if (pendingApproval && payload.step_id === pendingApproval.step_id) rejection = payload;
  });
  setHandler(cancelRunSignal, (payload) => {
    cancellation = payload;
  });
  setHandler(getStatusQuery, () => status);
  setHandler(getPendingApprovalQuery, () => pendingApproval);
  setHandler(getCostQuery, () => ({ total_cost_usd: totalCost }));
  setHandler(getStepSummariesQuery, () => stepSummaries);

  const finish = async (finalStatus: AgentRunWorkflowResult["status"]) => {
    status = finalStatus;
    await bookkeeping.finalizeRun({
      run,
      spec,
      status: finalStatus,
      steps: stepSummaries,
      intervention_ms: interventionMs,
      total_cost_usd: totalCost,
      model_cost_usd: input.model_cost_usd ?? 0,
    });
    return {
      status: finalStatus,
      proposed_changes: proposedChanges,
      completed_writes: completedWrites,
      total_cost_usd: totalCost,
    };
  };

  // 1–2. Load immutable spec (input) and re-evaluate policy.
  await bookkeeping.recordRunStatus({ run, status: "validating" });
  const policy = await readActivities.evaluateRunPolicy({
    spec,
    policy_version_id: run.policy_version_id,
  });
  if (policy.decision === "deny") return finish("policy_blocked");

  // 3–15. Execute steps in order.
  const orderedSteps = [...spec.steps].sort((a, b) => a.order - b.order);
  let lastDiffSha: string | null = null;

  for (const step of orderedSteps) {
    if (cancellation) return finish("cancelled");

    const summary: RunStepSummary = {
      step_id: step.step_id,
      step_order: step.order,
      capability_id: step.capability_id,
      mode: step.mode,
      status: "running",
    };
    stepSummaries.push(summary);

    if (step.mode === "read" || step.mode === "propose_write") {
      status = step.mode === "read" ? "running_read" : "preparing_diff";
      await bookkeeping.recordRunStatus({ run, status });
      let result: StepActivityResult;
      try {
        result = await readActivities.executeReadStep({
          spec,
          step_id: step.step_id,
          outputs,
          run,
        });
      } catch {
        summary.status = "failed";
        return finish("failed");
      }
      outputs = result.outputs;
      totalCost += result.cost_usd ?? 0;
      if (result.status === "failed") {
        summary.status = "failed";
        if (result.error_code) summary.error_code = result.error_code;
        await bookkeeping.recordStepResult({
          run,
          step_id: step.step_id,
          step_order: step.order,
          capability_id: step.capability_id,
          mode: step.mode,
          result,
        });
        return finish("failed");
      }
      summary.status = "completed";
      if (result.diff_sha256) {
        summary.diff_sha256 = result.diff_sha256;
        lastDiffSha = result.diff_sha256;
        proposedChanges += result.change_count ?? 0;
      }
      await bookkeeping.recordStepResult({
        run,
        step_id: step.step_id,
        step_order: step.order,
        capability_id: step.capability_id,
        mode: step.mode,
        result,
      });
      continue;
    }

    // step.mode === "write"
    if (run.mode === "shadow") {
      // 7. Shadow: never write. The step is recorded as skipped.
      summary.status = "skipped";
      await bookkeeping.recordStepResult({
        run,
        step_id: step.step_id,
        step_order: step.order,
        capability_id: step.capability_id,
        mode: step.mode,
        result: { status: "skipped_shadow_write", outputs },
      });
      continue;
    }

    if (!lastDiffSha) {
      summary.status = "failed";
      return finish("failed"); // a write without a preceding proposal is invalid
    }

    // 8–9. Approval gate.
    if (step.approval.required) {
      pendingApproval = { step_id: step.step_id, diff_sha256: lastDiffSha };
      approval = null;
      rejection = null;
      status = "waiting_approval";
      summary.status = "waiting_approval";
      await bookkeeping.recordRunStatus({ run, status });
      await bookkeeping.createApproval({
        run,
        step_id: step.step_id,
        diff_sha256: lastDiffSha,
        timeout_minutes: spec.failure_policy.approval_timeout_minutes,
      });

      const waitStart = Date.now();
      const decided = await condition(
        () => approval !== null || rejection !== null || cancellation !== null,
        `${spec.failure_policy.approval_timeout_minutes}m`,
      );
      interventionMs += Date.now() - waitStart;
      pendingApproval = null;

      if (!decided) return finish("expired"); // 24h default timeout → safe cancel
      if (cancellation) return finish("cancelled");
      if (rejection) return finish("cancelled");
    }

    // 10–12. Recheck policy, write once with idempotency key, verify.
    const recheck = await readActivities.evaluateRunPolicy({
      spec,
      policy_version_id: run.policy_version_id,
    });
    if (recheck.decision === "deny") return finish("policy_blocked");

    status = "applying_write";
    await bookkeeping.recordRunStatus({ run, status });
    let writeResult: StepActivityResult;
    try {
      writeResult = await writeActivities.executeWriteStep({
        spec,
        step_id: step.step_id,
        outputs,
        run,
        approved_diff_sha: lastDiffSha,
      });
    } catch {
      summary.status = "failed";
      return finish("failed");
    }
    outputs = writeResult.outputs;
    totalCost += writeResult.cost_usd ?? 0;
    if (writeResult.status === "failed") {
      summary.status = "failed";
      if (writeResult.error_code) summary.error_code = writeResult.error_code;
      return finish("failed");
    }

    status = "verifying";
    await bookkeeping.recordRunStatus({ run, status });
    summary.status = "completed";
    completedWrites += 1;
    if (writeResult.verified === false) warnings = true;
    await bookkeeping.recordStepResult({
      run,
      step_id: step.step_id,
      step_order: step.order,
      capability_id: step.capability_id,
      mode: step.mode,
      result: writeResult,
    });
  }

  // 13–15. Finalize (usage, ROI, sanitized completion happen in the activity).
  return finish(warnings ? "completed_with_warnings" : "completed");
}
