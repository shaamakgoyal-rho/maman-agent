import { capabilitiesForToken, getCapability } from "@maman/capability-catalog";
import {
  uuidv7,
  type AgentSpec,
  type AgentStep,
  type PatternCandidate,
  type PolicyDecision,
} from "@maman/contracts";
import {
  modelCostUsd,
  sumUsage,
  type ModelProvider,
  type ModelUsage,
  type NamingInput,
} from "@maman/model-provider";
import { evaluateSpec, type EvaluationContext, type OrgPolicy } from "@maman/policy-engine";
import { validateAgentSpec, type ValidationIssue } from "./validator.js";

/**
 * AgentSpec compiler (spec §13). Order of authority:
 *   1. deterministic recipe when the pattern maps to a known shape
 *   2. constrained model draft (twice), validated against everything
 *   3. blocked recommendation asking the user to clarify
 * The compiler produces ONLY AgentSpec JSON; the model never changes
 * eligibility, risk, permissions, or budgets.
 */

export type CompileRequest = {
  candidate: PatternCandidate;
  generalized_intent: string;
  desired_outcome: string;
  organization_id: string;
  owner_user_id: string;
  budgets: AgentSpec["budgets"];
  policy: OrgPolicy;
  policy_version_id: string;
  now: () => Date;
  model?: ModelProvider;
};

export type CompileResult =
  | {
      status: "valid";
      spec: AgentSpec;
      plain_language_plan: string[];
      policy_decision: PolicyDecision;
      warnings: string[];
      compiled_by: "recipe" | "model";
      /** Model usage across naming + drafting for this compile (null if none). */
      model_usage: ModelUsage | null;
      /** Priced compile cost from the usage above ($0 in demo mode). */
      model_cost_usd: number;
    }
  | { status: "blocked"; issues: ValidationIssue[]; message: string };

/** Copy the model may set (title/summary only); deterministic values win. */
type NameCopy = { title: string; summary: string } | null;

// ---- deterministic recipes ----

type Recipe = {
  /** Whether this recipe safely covers the given generalized intent. */
  matches: (intent: string) => boolean;
  build: (req: CompileRequest) => {
    steps: AgentStep[];
    inputs: AgentSpec["inputs"];
    assertions: AgentSpec["assertions"];
  };
};

/** Derived intents the deterministic naming emits for CRM update patterns. */
const UPDATE_RECORDS_INTENT = /^update_([a-z0-9_]+)_records$/;

/** Salesforce object for an update_<object>_records intent ("record" = unknown). */
function salesforceObjectFor(intent: string): string {
  const raw = UPDATE_RECORDS_INTENT.exec(intent)?.[1];
  if (!raw || raw === "record") return "Account";
  return raw
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

const step = (
  order: number,
  step_id: string,
  name: string,
  capability_id: string,
  mode: AgentStep["mode"],
  inputs: AgentStep["inputs"],
  output_key: string,
  opts: Partial<Pick<AgentStep, "risk_level" | "approval">> = {},
): AgentStep => {
  const capability = getCapability(capability_id);
  const risk = opts.risk_level ?? capability?.risk_level ?? "low";
  return {
    step_id,
    order,
    name,
    capability_id,
    capability_version: capability?.version ?? 1,
    mode,
    inputs,
    output_key,
    risk_level: risk,
    approval: opts.approval ?? { required: mode === "write" },
    retry: {
      allowed: capability?.retry_class === "safe",
      max_attempts: capability?.retry_class === "safe" ? 3 : 0,
      backoff_seconds: capability?.retry_class === "safe" ? [1, 5, 30] : [],
    },
  };
};

/**
 * The primary demo recipe: account-list reconciliation (spec §24 exactly).
 * Also covers the derived update_<object>_records intents that live-observed
 * CRM edit patterns produce — same safe shape (read → match → propose →
 * approved write → report), with the queried object taken from the intent.
 */
const RECONCILIATION_RECIPE: Recipe = {
  matches: (intent) => intent === "reconcile_account_list" || UPDATE_RECORDS_INTENT.test(intent),
  build: (req) => ({
    inputs: [
      {
        key: "account_csv",
        label: "Account list (CSV)",
        type: "file_reference",
        required: true,
        sensitivity: "internal",
        source: "user",
      },
    ],
    steps: [
      step(
        1,
        "parse-csv",
        "Parse account CSV",
        "local.parse_csv",
        "read",
        { file: { source: "agent_input", ref: "account_csv" } },
        "rows",
      ),
      step(
        2,
        "normalize-domains",
        "Normalize company domains",
        "local.transform_columns",
        "read",
        {
          rows: { source: "step_output", ref: "rows" },
          transform: { source: "literal", value: "normalize_domain" },
        },
        "normalized_rows",
      ),
      step(
        3,
        "query-accounts",
        "Query matching Salesforce Accounts",
        "salesforce.query_records",
        "read",
        {
          keys: { source: "step_output", ref: "normalized_rows" },
          object: { source: "literal", value: salesforceObjectFor(req.generalized_intent) },
        },
        "sf_accounts",
      ),
      step(
        4,
        "match-records",
        "Match records and flag ambiguous rows",
        "local.match_records",
        "read",
        {
          left: { source: "step_output", ref: "normalized_rows" },
          right: { source: "step_output", ref: "sf_accounts" },
        },
        "matches",
      ),
      step(
        5,
        "propose-updates",
        "Propose allowed field updates",
        "salesforce.propose_field_updates",
        "propose_write",
        { matches: { source: "step_output", ref: "matches" } },
        "proposed_updates",
      ),
      step(
        6,
        "apply-updates",
        "Apply approved field updates",
        "salesforce.update_fields",
        "write",
        { proposal: { source: "step_output", ref: "proposed_updates" } },
        "update_result",
        { approval: { required: true, reason: "material CRM write" } },
      ),
      step(
        7,
        "report",
        "Produce reconciliation CSV",
        "local.generate_csv",
        "read",
        {
          matches: { source: "step_output", ref: "matches" },
          updates: { source: "step_output", ref: "update_result" },
        },
        "report_csv",
      ),
    ],
    assertions: [
      {
        assertion_id: "no-duplicate-keys",
        type: "no_duplicate_keys",
        config: { output_key: "matches", key_field: "company_domain" },
        severity: "blocking",
      },
      {
        assertion_id: "row-count",
        type: "record_count_between",
        config: { output_key: "rows", min: 1, max: 1000 },
        severity: "blocking",
      },
      {
        assertion_id: "update-limit",
        type: "diff_within_limit",
        config: { step_id: "apply-updates", max_changes: 20 },
        severity: "blocking",
      },
    ],
  }),
};

const RECIPES: Recipe[] = [RECONCILIATION_RECIPE];

function allowedCapabilityIds(req: CompileRequest): string[] {
  return req.candidate.canonical_sequence
    .flatMap((token) => capabilitiesForToken(token))
    .filter((v, i, a) => a.indexOf(v) === i);
}

/** Redacted, identity-safe naming input built from the candidate. */
function namingInputFor(req: CompileRequest, allowed: string[]): NamingInput {
  return {
    generalized_intent: req.generalized_intent,
    app_categories: [],
    object_type: "record",
    occurrence_count: req.candidate.occurrence_count,
    distinct_day_count: req.candidate.distinct_day_count,
    median_duration_minutes: Math.round(req.candidate.median_duration_ms / 60000),
    redacted_steps: req.candidate.canonical_sequence.map((token, i) => ({
      order: i + 1,
      app: "app",
      action: token,
    })),
    allowed_capability_ids: allowed,
  };
}

export async function compileAgentSpec(req: CompileRequest): Promise<CompileResult> {
  const allowed = allowedCapabilityIds(req);
  const usages: ModelUsage[] = [];
  const budget = req.budgets.max_cost_usd;
  let nameCopy: NameCopy = null;

  // Semantic naming (COPY only) — best effort. Deterministic values remain
  // authoritative; a failed/over-budget naming call keeps the deterministic
  // title/summary. The model may never introduce a capability id here either.
  if (req.model) {
    const naming = await req.model.nameRecommendation(namingInputFor(req, allowed));
    if (naming.ok && modelCostUsd(sumUsage([...usages, naming.usage])) <= budget) {
      usages.push(naming.usage);
      nameCopy = { title: naming.value.title, summary: naming.value.summary };
    }
  }

  // 1. Deterministic recipe when the intent maps to a known shape.
  const recipe = RECIPES.find((r) => r.matches(req.generalized_intent));
  if (recipe) {
    return finalize(req, recipe.build(req), "recipe", [], usages, nameCopy);
  }

  // 2. Constrained model draft (twice), fully validated. Budget-capped: a draft
  //    whose priced cost would exceed the compile budget is dropped and we fall
  //    through to "blocked" rather than compiling an over-budget helper.
  if (req.model) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const draft = await req.model.draftAgentPlan({
        generalized_intent: req.generalized_intent,
        desired_outcome: req.desired_outcome,
        canonical_steps: req.candidate.canonical_sequence,
        allowed_capability_ids: allowed,
        budgets: {
          max_cost_usd: req.budgets.max_cost_usd,
          max_records_written: req.budgets.max_records_written,
        },
      });
      if (!draft.ok) continue;
      if (modelCostUsd(sumUsage([...usages, draft.usage])) > budget) break; // over budget → stop
      const built = planToSpecParts(draft.value);
      if (!built) continue;
      const result = finalize(req, built, "model", [], [...usages, draft.usage], nameCopy);
      if (result.status === "valid") return result;
    }
  }

  return {
    status: "blocked",
    issues: [
      {
        rule: "C-NO-PLAN",
        message: "no deterministic recipe matches and model generation failed or is unavailable",
      },
    ],
    message:
      "I couldn't safely draft this helper yet. Tell me more about the outcome you want, or try again after connecting the relevant tools.",
  };
}

/** Converts a validated model plan into buildable spec parts, or null. */
function planToSpecParts(
  plan: unknown,
): { steps: AgentStep[]; inputs: AgentSpec["inputs"]; assertions: AgentSpec["assertions"] } | null {
  if (typeof plan !== "object" || plan === null) return null;
  const steps = (plan as { steps?: unknown }).steps;
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > 20) return null;
  const built: AgentStep[] = [];
  for (const [index, item] of steps.entries()) {
    const capabilityId = (item as { capability_id?: unknown }).capability_id;
    if (typeof capabilityId !== "string") return null;
    const capability = getCapability(capabilityId);
    if (!capability) return null; // model asked for an arbitrary tool → reject
    const mode = capability.supported_modes.includes("write")
      ? "propose_write" // model drafts never get direct write steps
      : capability.supported_modes[0]!;
    built.push(
      step(
        index + 1,
        `step-${index + 1}`,
        capability.display_name,
        capabilityId,
        mode,
        {},
        `out_${index + 1}`,
      ),
    );
  }
  return { steps: built, inputs: [], assertions: [] };
}

function finalize(
  req: CompileRequest,
  parts: { steps: AgentStep[]; inputs: AgentSpec["inputs"]; assertions: AgentSpec["assertions"] },
  compiled_by: "recipe" | "model",
  warnings: string[],
  usages: ModelUsage[],
  nameCopy: NameCopy,
): CompileResult {
  const now = req.now();
  const deterministicName =
    req.generalized_intent === "reconcile_account_list"
      ? "Reconcile account lists with Salesforce"
      : `Helper: ${req.generalized_intent.replaceAll("_", " ")}`;
  const spec: AgentSpec = {
    schema_version: 1,
    agent_id: uuidv7({ timestampMs: now.getTime(), random: seeded(req.candidate.pattern_id) }),
    version_id: uuidv7({
      timestampMs: now.getTime() + 1,
      random: seeded(req.candidate.pattern_id + "v"),
    }),
    organization_id: req.organization_id,
    owner_user_id: req.owner_user_id,
    // Model may supply the title as COPY; deterministic name is the fallback.
    name: nameCopy?.title ?? deterministicName,
    description: nameCopy?.summary ?? req.desired_outcome,
    generalized_intent: req.generalized_intent,
    source_pattern_id: req.candidate.pattern_id,
    state: "draft",
    trigger: { type: "manual" },
    inputs: parts.inputs,
    steps: parts.steps,
    assertions: parts.assertions,
    budgets: req.budgets,
    failure_policy: {
      on_assertion_failure: "stop",
      on_tool_failure: "stop",
      max_safe_retries: 1,
      approval_timeout_minutes: 24 * 60,
    },
    created_at: now.toISOString(),
    created_by: "compiler",
  };

  const validation = validateAgentSpec(spec);
  if (!validation.valid) {
    return {
      status: "blocked",
      issues: validation.issues,
      message: `The draft failed safety validation: ${validation.issues[0]?.message ?? "unknown"}`,
    };
  }

  const ctx: EvaluationContext = {
    policy_version_id: req.policy_version_id,
    evaluated_at: now.toISOString(),
  };
  const decision = evaluateSpec(validation.spec, req.policy, ctx);
  if (decision.decision === "deny") {
    return {
      status: "blocked",
      issues: decision.reasons.map((r) => ({ rule: r.rule_id, message: r.message })),
      message: `Organization policy blocked this draft: ${decision.reasons[0]?.message ?? ""}`,
    };
  }

  const model_usage = usages.length > 0 ? sumUsage(usages) : null;
  return {
    status: "valid",
    spec: validation.spec,
    plain_language_plan: renderPlainLanguagePlan(validation.spec),
    policy_decision: decision,
    warnings,
    compiled_by,
    model_usage,
    model_cost_usd: model_usage ? modelCostUsd(model_usage) : 0,
  };
}

/** Plain-language plan: inputs, steps, approval points, budgets, rollback. */
export function renderPlainLanguagePlan(spec: AgentSpec): string[] {
  const lines: string[] = [];
  if (spec.inputs.length > 0) {
    lines.push(
      `You provide: ${spec.inputs.map((i) => i.label + (i.required ? "" : " (optional)")).join(", ")}.`,
    );
  }
  for (const s of [...spec.steps].sort((a, b) => a.order - b.order)) {
    const capability = getCapability(s.capability_id);
    let line = `${s.order}. ${s.name}`;
    if (s.mode === "propose_write") line += " — proposes changes only, writes nothing";
    if (s.mode === "write") line += " — WAITS FOR YOUR APPROVAL, then writes once";
    if (capability && capability.connector !== "local") line += ` (via ${capability.connector})`;
    lines.push(line);
  }
  lines.push(
    `Limits: at most ${spec.budgets.max_records_written} records written, ` +
      `$${spec.budgets.max_cost_usd.toFixed(2)} per run, ` +
      `${Math.round(spec.budgets.max_runtime_seconds / 60)} minutes runtime.`,
  );
  lines.push(
    "If anything looks wrong, the run stops safely. Completed external writes are never silently rolled back — reversals are separate approved actions.",
  );
  return lines;
}

function seeded(seed: string): () => number {
  let h = 2166136261;
  for (const c of seed) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
}
