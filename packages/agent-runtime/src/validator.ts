import { capabilityExists, getCapability } from "@maman/capability-catalog";
import { agentSpecSchema, looksLikeSecret, type AgentSpec } from "@maman/contracts";

/**
 * Static AgentSpec validation (spec §13). Every locked rejection condition is
 * enforced here, before policy evaluation. Deterministic; no LLM anywhere.
 */

export const MAX_STEPS = 20;
export const MAX_RUNTIME_SECONDS = 30 * 60;
export const MAX_RECORD_WRITES = 500;
export const MIN_SCHEDULE_INTERVAL_MINUTES = 15;

export type ValidationIssue = { rule: string; message: string };
export type ValidationResult =
  { valid: true; spec: AgentSpec } | { valid: false; issues: ValidationIssue[] };

const issue = (rule: string, message: string): ValidationIssue => ({ rule, message });

export function validateAgentSpec(raw: unknown): ValidationResult {
  // Schema layer: unknown fields anywhere are rejected (strict schemas).
  const parsed = agentSpecSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      valid: false,
      issues: parsed.error.issues.map((i) =>
        issue("V-SCHEMA", `${i.path.join(".")}: ${i.message}`),
      ),
    };
  }
  const spec = parsed.data;
  const issues: ValidationIssue[] = [];

  // more than twenty steps
  if (spec.steps.length > MAX_STEPS) {
    issues.push(issue("V-STEPS-1", `spec has ${spec.steps.length} steps; maximum is ${MAX_STEPS}`));
  }

  // duplicate or noncontiguous step order
  const orders = spec.steps.map((s) => s.order).sort((a, b) => a - b);
  const contiguous = orders.every((o, i) => o === i + 1);
  if (!contiguous) {
    issues.push(
      issue("V-STEPS-2", "step order must be contiguous starting at 1 with no duplicates"),
    );
  }
  const stepIds = new Set(spec.steps.map((s) => s.step_id));
  if (stepIds.size !== spec.steps.length) {
    issues.push(issue("V-STEPS-3", "duplicate step_id"));
  }

  // referenced inputs and step outputs must exist; no circular deps
  const inputKeys = new Set(spec.inputs.map((i) => i.key));
  const outputsByStep = new Map(spec.steps.map((s) => [s.output_key, s.order]));
  for (const step of spec.steps) {
    for (const [inputName, binding] of Object.entries(step.inputs)) {
      if (binding.source === "agent_input" && !inputKeys.has(binding.ref)) {
        issues.push(
          issue(
            "V-REF-1",
            `step ${step.step_id} input ${inputName} references missing agent input ${binding.ref}`,
          ),
        );
      }
      if (binding.source === "step_output") {
        const producerOrder = outputsByStep.get(binding.ref);
        if (producerOrder === undefined) {
          issues.push(
            issue(
              "V-REF-2",
              `step ${step.step_id} input ${inputName} references missing step output ${binding.ref}`,
            ),
          );
        } else if (producerOrder >= step.order) {
          // forward/self references are circular by construction in an ordered plan
          issues.push(
            issue(
              "V-REF-3",
              `step ${step.step_id} references output ${binding.ref} produced at or after it`,
            ),
          );
        }
      }
      if (binding.source === "literal" && typeof binding.value === "string") {
        if (looksLikeSecret(binding.value)) {
          issues.push(issue("V-SECRET-1", `step ${step.step_id} contains a secret-shaped literal`));
        }
        if (/^https?:\/\//i.test(binding.value)) {
          // any URL is outside a connector's allowlisted host unless the
          // capability declares one — v1 allows no URL literals at all.
          issues.push(issue("V-URL-1", `step ${step.step_id} contains a URL literal`));
        }
        if (/[;&|`$]|<script|SELECT\s+.*\s+FROM|DROP\s+TABLE/i.test(binding.value)) {
          issues.push(
            issue(
              "V-EXEC-1",
              `step ${step.step_id} literal looks like code/SQL/shell — arbitrary execution is prohibited`,
            ),
          );
        }
      }
    }

    // capability checks
    if (!capabilityExists(step.capability_id)) {
      issues.push(
        issue("V-CAP-1", `step ${step.step_id}: capability ${step.capability_id} does not exist`),
      );
      continue;
    }
    const capability = getCapability(step.capability_id)!;
    if (capability.version !== step.capability_version) {
      issues.push(
        issue(
          "V-CAP-2",
          `step ${step.step_id}: capability version ${step.capability_version} unavailable (current ${capability.version})`,
        ),
      );
    }
    if (!capability.supported_modes.includes(step.mode)) {
      issues.push(
        issue(
          "V-CAP-3",
          `step ${step.step_id}: mode ${step.mode} exceeds capability's supported modes`,
        ),
      );
    }
    if (step.mode === "write" && !capability.supported_modes.includes("propose_write")) {
      issues.push(
        issue("V-CAP-4", `step ${step.step_id}: write capability lacks propose_write/dry-run`),
      );
    }
    if (step.risk_level === "prohibited") {
      issues.push(issue("V-RISK-1", `step ${step.step_id}: prohibited risk`));
    }
    if (step.risk_level === "high" && !step.approval.required) {
      issues.push(issue("V-RISK-2", `step ${step.step_id}: high-risk step lacks approval`));
    }
  }

  // budgets
  if (spec.budgets.max_runtime_seconds > MAX_RUNTIME_SECONDS) {
    issues.push(
      issue(
        "V-BUDGET-1",
        `max runtime ${spec.budgets.max_runtime_seconds}s exceeds thirty minutes`,
      ),
    );
  }
  if (spec.budgets.max_records_written > MAX_RECORD_WRITES) {
    issues.push(
      issue(
        "V-BUDGET-2",
        `max record writes ${spec.budgets.max_records_written} exceeds ${MAX_RECORD_WRITES}`,
      ),
    );
  }

  // schedule frequency
  if (spec.trigger.type === "schedule") {
    const interval = minCronIntervalMinutes(spec.trigger.cron);
    if (interval !== null && interval < MIN_SCHEDULE_INTERVAL_MINUTES) {
      issues.push(
        issue(
          "V-SCHED-1",
          `schedule repeats every ${interval} minutes; minimum is ${MIN_SCHEDULE_INTERVAL_MINUTES}`,
        ),
      );
    }
    if (interval === null) {
      issues.push(issue("V-SCHED-2", "unparseable cron expression"));
    }
  }

  if (issues.length > 0) return { valid: false, issues };
  return { valid: true, spec };
}

/**
 * Conservative minimum-interval estimate for a 5-field cron expression.
 * Returns null when the expression cannot be understood (then rejected).
 */
export function minCronIntervalMinutes(cron: string): number | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute] = fields;
  if (minute === undefined) return null;
  if (minute === "*") return 1;
  const stepMatch = minute.match(/^\*\/(\d+)$/);
  if (stepMatch) return Number(stepMatch[1]);
  if (/^\d+$/.test(minute)) return 60; // a fixed minute → at most hourly
  if (/^(\d+,)+\d+$/.test(minute)) {
    const values = minute
      .split(",")
      .map(Number)
      .sort((a, b) => a - b);
    let min = 60 - values[values.length - 1]! + values[0]!;
    for (let i = 1; i < values.length; i++) min = Math.min(min, values[i]! - values[i - 1]!);
    return min;
  }
  return null;
}
