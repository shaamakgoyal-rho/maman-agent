import { stepIdempotencyKey, type AgentSpec, type AgentStep } from "@maman/contracts";
import {
  diffSha256,
  TransientAdapterError,
  type CapabilityAdapter,
  type CapabilityContext,
  type ProposedDiff,
} from "./adapters.js";

/**
 * Pure step executor used by Temporal activities (and directly by tests).
 * Shadow mode NEVER reaches an adapter's write() — structurally: the shadow
 * branch returns before any write dispatch exists on its code path.
 */

export type StepExecution =
  | { kind: "read"; output: unknown }
  | { kind: "proposed"; diff: ProposedDiff; diff_sha256: string }
  | {
      kind: "written";
      output: unknown;
      idempotency_key: string;
      verified: boolean;
      verify_detail: string;
    }
  | { kind: "skipped_shadow_write" };

export type RunState = {
  outputs: Record<string, unknown>;
};

export function resolveStepInputs(
  step: AgentStep,
  spec: AgentSpec,
  state: RunState,
  agentInputs: Record<string, unknown>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [name, binding] of Object.entries(step.inputs)) {
    if (binding.source === "literal") resolved[name] = binding.value;
    if (binding.source === "agent_input") resolved[name] = agentInputs[binding.ref];
    if (binding.source === "step_output") resolved[name] = state.outputs[binding.ref];
  }
  void spec;
  return resolved;
}

export async function executeStep(input: {
  spec: AgentSpec;
  step: AgentStep;
  state: RunState;
  agentInputs: Record<string, unknown>;
  ctx: CapabilityContext;
  adapter: CapabilityAdapter;
  /** Present only for write execution after approval. */
  approvedDiff?: ProposedDiff;
  approvedDiffSha?: string;
  maxAttempts?: number;
}): Promise<StepExecution> {
  const { step, ctx, adapter } = input;
  const inputs = resolveStepInputs(step, input.spec, input.state, input.agentInputs);

  const attempt = async <T>(fn: () => Promise<T>): Promise<T> => {
    const max = input.maxAttempts ?? (step.retry.allowed ? step.retry.max_attempts : 1);
    let lastError: unknown;
    for (let i = 0; i < Math.max(1, max); i++) {
      try {
        return await fn();
      } catch (e) {
        lastError = e;
        if (!(e instanceof TransientAdapterError)) throw e; // permanent: no retry
      }
    }
    throw lastError;
  };

  if (step.mode === "read") {
    if (!adapter.read) throw new Error(`${step.capability_id} has no read implementation`);
    const output = await attempt(() => adapter.read!(inputs, ctx));
    input.state.outputs[step.output_key] = output;
    return { kind: "read", output };
  }

  if (step.mode === "propose_write") {
    if (!adapter.proposeWrite) {
      throw new Error(`${step.capability_id} has no proposeWrite implementation`);
    }
    const diff = await attempt(() => adapter.proposeWrite!(inputs, ctx));
    input.state.outputs[step.output_key] = diff;
    return { kind: "proposed", diff, diff_sha256: diffSha256(diff) };
  }

  // step.mode === "write"
  if (ctx.mode === "shadow") {
    // Shadow runs never call write — the proposed diff IS the result.
    return { kind: "skipped_shadow_write" };
  }
  if (!adapter.write) throw new Error(`${step.capability_id} has no write implementation`);
  if (!input.approvedDiff || !input.approvedDiffSha) {
    throw new Error(`write step ${step.step_id} reached execution without an approved diff`);
  }
  // Diff-hash binding: a changed diff invalidates the approval.
  if (diffSha256(input.approvedDiff) !== input.approvedDiffSha) {
    throw new Error(`approved diff hash mismatch for step ${step.step_id}`);
  }
  const idempotencyKey = stepIdempotencyKey({
    run_id: ctx.run_id,
    agent_version_id: input.spec.version_id,
    step_id: step.step_id,
    capability_version: step.capability_version,
    diff_hash: input.approvedDiffSha,
  });
  // Writes are NEVER auto-retried unless the adapter's retry class is safe —
  // conditional/unsafe writes get exactly one attempt (idempotency ledger
  // makes an explicit re-run return the prior result instead of re-applying).
  const output = await adapter.write(inputs, input.approvedDiff, ctx, idempotencyKey);
  input.state.outputs[step.output_key] = output;

  let verified = false;
  let verify_detail = "no verifier";
  if (adapter.verify) {
    const verification = await adapter.verify(inputs, output, ctx);
    verified = verification.verified;
    verify_detail = verification.detail;
  }
  return { kind: "written", output, idempotency_key: idempotencyKey, verified, verify_detail };
}
