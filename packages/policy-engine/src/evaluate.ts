import { capabilityExists, getCapability } from "@maman/capability-catalog";
import type { AgentSpec, AgentStep, PolicyDecision } from "@maman/contracts";
import type { OrgPolicy } from "./org-policy.js";
import { approvalRequirement, classifyStepRisk, type EffectiveRisk } from "./risk.js";

/**
 * Deterministic policy evaluation. Every decision carries machine-readable
 * reasons and is persisted with the run/compilation that caused it.
 */

export type EvaluationContext = {
  policy_version_id: string;
  evaluated_at: string; // injectable clock (ISO UTC)
  /** Approval already granted for this exact run+step+diff (M7 signals). */
  approved_step_ids?: string[];
};

type Reason = { code: string; message: string; rule_id: string };

function reason(code: string, message: string, rule_id: string): Reason {
  return { code, message, rule_id };
}

function capabilityAllowed(policy: OrgPolicy, capabilityId: string, version: number): boolean {
  if (policy.disabled_capabilities.includes(capabilityId)) return false;
  const capability = getCapability(capabilityId);
  if (!capability) return false;
  if (!policy.enabled_connectors.includes(capability.connector)) return false;
  if (policy.allowed_capabilities === "catalog") return capability.version === version;
  return policy.allowed_capabilities.some((c) => c.id === capabilityId && c.version === version);
}

export function effectiveStepRisk(step: AgentStep, spec: AgentSpec): EffectiveRisk {
  return classifyStepRisk({
    capability_id: step.capability_id,
    mode: step.mode,
    max_records_written: spec.budgets.max_records_written,
    updated_fields: Object.keys(step.inputs).map((k) => k.toLowerCase()),
    ui_only_write: step.capability_id === "browser.supervised_form_fill" && step.mode === "write",
  });
}

/** Evaluates one step for execution (called before every material action). */
export function evaluateStep(
  spec: AgentSpec,
  step: AgentStep,
  policy: OrgPolicy,
  ctx: EvaluationContext,
): PolicyDecision {
  const reasons: Reason[] = [];
  const risk = effectiveStepRisk(step, spec);

  if (!capabilityExists(step.capability_id)) {
    reasons.push(
      reason("unknown_capability", `capability ${step.capability_id} does not exist`, "P-CAP-1"),
    );
  } else if (!capabilityAllowed(policy, step.capability_id, step.capability_version)) {
    reasons.push(
      reason(
        "capability_disabled",
        `capability ${step.capability_id} v${step.capability_version} is not allowed by organization policy`,
        "P-CAP-2",
      ),
    );
  }
  if (risk === "prohibited") {
    reasons.push(reason("prohibited_risk", "step operation is prohibited in v1", "P-RISK-1"));
  }
  if (reasons.length > 0) {
    return {
      decision: "deny",
      policy_version_id: ctx.policy_version_id,
      evaluated_at: ctx.evaluated_at,
      reasons,
      limits: {},
    };
  }

  const requirement = approvalRequirement(risk, step.mode, {
    capability_id: step.capability_id,
    unattended_medium_capabilities: policy.unattended_medium_capabilities,
  });

  if (requirement === "none") {
    return {
      decision: "allow",
      policy_version_id: ctx.policy_version_id,
      evaluated_at: ctx.evaluated_at,
      reasons: [reason("allowed", `${risk}-risk ${step.mode} step permitted`, "P-ALLOW-1")],
      limits: {
        max_records: policy.max_records_written,
        max_cost_usd: policy.max_run_cost_usd,
      },
    };
  }

  return {
    decision: "require_approval",
    policy_version_id: ctx.policy_version_id,
    evaluated_at: ctx.evaluated_at,
    reasons: [
      reason(
        requirement === "always" ? "high_risk_approval" : "medium_write_approval",
        requirement === "always"
          ? "high-risk steps require run-specific approval and may never become unattended in v1"
          : "medium-risk writes require one approval per run",
        requirement === "always" ? "P-APPR-2" : "P-APPR-1",
      ),
    ],
    limits: {
      max_records: policy.max_records_written,
      max_cost_usd: policy.max_run_cost_usd,
    },
  };
}

/** Evaluates a whole spec at compile/promote time. Deny if ANY rule fails. */
export function evaluateSpec(
  spec: AgentSpec,
  policy: OrgPolicy,
  ctx: EvaluationContext,
): PolicyDecision {
  const reasons: Reason[] = [];

  for (const step of spec.steps) {
    const stepDecision = evaluateStep(spec, step, policy, ctx);
    if (stepDecision.decision === "deny") {
      reasons.push(
        ...stepDecision.reasons.map((r) => ({
          ...r,
          message: `step ${step.step_id}: ${r.message}`,
        })),
      );
    }
    const risk = effectiveStepRisk(step, spec);
    if (risk === "high" && !step.approval.required) {
      reasons.push(
        reason(
          "high_risk_missing_approval",
          `step ${step.step_id}: high-risk step must declare approval`,
          "P-APPR-3",
        ),
      );
    }
  }

  if (spec.budgets.max_records_written > policy.max_records_written) {
    reasons.push(
      reason(
        "write_budget_exceeded",
        `spec writes up to ${spec.budgets.max_records_written} records; organization allows ${policy.max_records_written}`,
        "P-BUDGET-1",
      ),
    );
  }
  if (spec.budgets.max_records_read > policy.max_records_read) {
    reasons.push(
      reason(
        "read_budget_exceeded",
        `spec reads up to ${spec.budgets.max_records_read}; organization allows ${policy.max_records_read}`,
        "P-BUDGET-2",
      ),
    );
  }
  if (spec.budgets.max_cost_usd > policy.max_run_cost_usd) {
    reasons.push(
      reason(
        "cost_budget_exceeded",
        `spec cost budget $${spec.budgets.max_cost_usd} exceeds organization per-run limit $${policy.max_run_cost_usd}`,
        "P-BUDGET-3",
      ),
    );
  }
  if (spec.trigger.type === "schedule" && !policy.allow_scheduled_supervised) {
    reasons.push(
      reason(
        "schedule_not_allowed",
        "organization policy does not allow supervised agents to be scheduled",
        "P-SCHED-1",
      ),
    );
  }

  if (reasons.length > 0) {
    return {
      decision: "deny",
      policy_version_id: ctx.policy_version_id,
      evaluated_at: ctx.evaluated_at,
      reasons,
      limits: {},
    };
  }

  const needsApproval = spec.steps.some(
    (step) => evaluateStep(spec, step, policy, ctx).decision === "require_approval",
  );
  return {
    decision: needsApproval ? "require_approval" : "allow",
    policy_version_id: ctx.policy_version_id,
    evaluated_at: ctx.evaluated_at,
    reasons: [
      reason(
        needsApproval ? "spec_requires_approvals" : "spec_allowed",
        needsApproval
          ? "spec is valid; material writes pause for approval at run time"
          : "spec is valid and fully read-only",
        "P-SPEC-1",
      ),
    ],
    limits: {
      max_records: policy.max_records_written,
      max_cost_usd: Math.min(spec.budgets.max_cost_usd, policy.max_run_cost_usd),
    },
  };
}
