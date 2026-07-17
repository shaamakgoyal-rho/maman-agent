import { getCapability } from "@maman/capability-catalog";
import type { AgentStep } from "@maman/contracts";

/**
 * Deterministic risk classification (spec §14). Pure functions only.
 */

export type EffectiveRisk = "low" | "medium" | "high" | "prohibited";

/** Salesforce fields whose change is always HIGH risk. */
export const HIGH_RISK_CRM_FIELDS = [
  "stagename",
  "stage",
  "ownerid",
  "owner",
  "amount",
  "forecastcategory",
  "forecast_category",
  "hasoptedoutofemail",
  "consent",
  "donotcall",
] as const;

/** Operations that are PROHIBITED in v1 — these verbs may never execute. */
export const PROHIBITED_OPERATIONS = [
  "delete",
  "payment",
  "purchase",
  "transfer",
  "credential",
  "permission_change",
  "provision",
  "deprovision",
  "send",
  "social_post",
  "legal_accept",
  "code_execution",
  "shell",
  "disable_security",
] as const;

export const MAX_WRITE_RECORDS = 500;
export const MEDIUM_CRM_WRITE_LIMIT = 20;

export type StepRiskInput = {
  capability_id: string;
  mode: AgentStep["mode"];
  /** Records the step may write (from budgets/assertions/inputs). */
  max_records_written?: number;
  /** CRM field names the step updates (lowercased). */
  updated_fields?: string[];
  /** Whether the write target is UI-only with no API verification. */
  ui_only_write?: boolean;
  /** Whether the output is customer-facing content. */
  customer_facing?: boolean;
};

/**
 * Effective risk of one step. Starts from catalog metadata, then escalates
 * per the locked rules. Never de-escalates below the catalog level.
 */
export function classifyStepRisk(input: StepRiskInput): EffectiveRisk {
  // Prohibited verbs are checked FIRST — even a capability that somehow
  // entered the catalog with such a verb may never run.
  if (PROHIBITED_OPERATIONS.some((op) => input.capability_id.toLowerCase().includes(op))) {
    return "prohibited";
  }
  const capability = getCapability(input.capability_id);
  if (!capability) return "prohibited"; // unknown capability may never run

  let risk: EffectiveRisk = capability.risk_level;

  if (input.mode === "read") {
    // Reads never exceed their catalog level. (The catalog contains no
    // prohibited entries — verified by the catalog test suite.)
    return risk;
  }

  const records = input.max_records_written ?? 0;
  if (records > MAX_WRITE_RECORDS) return "prohibited";

  const isCrmWrite = capability.connector === "salesforce" && input.mode === "write";
  if (isCrmWrite && records > MEDIUM_CRM_WRITE_LIMIT) risk = escalate(risk, "high");
  if (input.updated_fields?.some((f) => (HIGH_RISK_CRM_FIELDS as readonly string[]).includes(f))) {
    risk = escalate(risk, "high");
  }
  if (input.ui_only_write) risk = escalate(risk, "high");
  if (input.customer_facing) risk = escalate(risk, "high");
  return risk;
}

const ORDER: EffectiveRisk[] = ["low", "medium", "high", "prohibited"];
function escalate(current: EffectiveRisk, to: EffectiveRisk): EffectiveRisk {
  return ORDER.indexOf(to) > ORDER.indexOf(current) ? to : current;
}

/** Approval requirement per risk level (spec §14). */
export function approvalRequirement(
  risk: EffectiveRisk,
  mode: AgentStep["mode"],
  opts: { capability_id: string; unattended_medium_capabilities: string[] },
): "none" | "per_run" | "always" | "denied" {
  if (risk === "prohibited") return "denied";
  if (mode === "read" || mode === "propose_write") return "none";
  if (risk === "high") return "always"; // may NEVER become unattended in v1
  if (risk === "medium") {
    return opts.unattended_medium_capabilities.includes(opts.capability_id) ? "none" : "per_run";
  }
  return "none";
}
