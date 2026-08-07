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
import {
  describeMissingCapabilities,
  validateRuntimeCapabilities,
  type CapabilityRuntime,
  type MissingCapability,
} from "./runtime-capabilities.js";

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
  /**
   * The runtime that will execute the result. When supplied, a recipe may only
   * emit steps this runtime has an adapter for, in the mode the step needs; a
   * workflow whose required capabilities are unavailable returns
   * `needs_runtime` instead of a spec that would crash mid-run.
   *
   * Optional so existing callers keep compiling (they then get the previous,
   * runtime-blind behaviour) — but the desktop and worker paths pass it.
   */
  runtime?: CapabilityRuntime;
};

export type CompileResult =
  | {
      status: "valid";
      spec: AgentSpec;
      plain_language_plan: string[];
      policy_decision: PolicyDecision;
      warnings: string[];
      compiled_by: "recipe" | "model";
      /**
       * Audit trail: which observed pattern, which derived intent, and which
       * recipe (or "model") produced this spec. Together with the spec's
       * `source_pattern_id` this makes every compiled agent traceable back to
       * the evidence it came from.
       */
      compiled_from: { pattern_id: string; generalized_intent: string; recipe: string };
      /** Model usage across naming + drafting for this compile (null if none). */
      model_usage: ModelUsage | null;
      /** Priced compile cost from the usage above ($0 in demo mode). */
      model_cost_usd: number;
    }
  | { status: "blocked"; issues: ValidationIssue[]; message: string }
  /**
   * A recipe covers this workflow, but the selected runtime cannot execute it.
   * Distinct from `blocked` on purpose: `blocked` means "we do not know how to
   * do this", while this means "we know how, but not here" — the user needs to
   * connect or install something, not describe their workflow differently.
   */
  | {
      status: "needs_runtime";
      runtime_id: string;
      missing: MissingCapability[];
      message: string;
    }
  /**
   * The workflow was recognised, but observation alone did not capture enough
   * to compile it safely — the user must teach the missing pieces. This is the
   * typed replacement for two dishonest behaviours: silently compiling an
   * unrelated generic recipe (an observed CRM-edit pattern used to become the
   * CSV→Salesforce reconciliation agent, inventing an `account_csv` input the
   * user never mentioned), and a generic "couldn't draft this" for workflows
   * that are perfectly automatable once configured.
   */
  | {
      status: "needs_configuration";
      missing: MissingConfiguration[];
      message: string;
    };

/** One concrete thing observation could not learn and the user must provide. */
export type MissingConfiguration = {
  kind: "data_source" | "field_mapping" | "target" | "success_condition" | "workflow_definition";
  detail: string;
};

/** Copy the model may set (title/summary only); deterministic values win. */
type NameCopy = { title: string; summary: string } | null;

// ---- deterministic recipes ----

type Recipe = {
  /** Stable identity, recorded on the compile result for the audit trail
   * (observed pattern → intent → recipe → spec). */
  id: string;
  /** Whether this recipe safely covers the given intent AND candidate — some
   * recipes are shaped by what was actually observed, not the intent alone. */
  matches: (intent: string, req: CompileRequest) => boolean;
  build: (req: CompileRequest) => {
    steps: AgentStep[];
    inputs: AgentSpec["inputs"];
    assertions: AgentSpec["assertions"];
  };
};

/**
 * Whether the compile target can execute `capabilityId`. With no runtime
 * supplied the answer is "assume yes" — the previous behaviour, kept so
 * existing callers are unaffected.
 */
function runtimeHas(req: CompileRequest, capabilityId: string): boolean {
  if (!req.runtime) return true;
  if (!req.runtime.available.has(capabilityId)) return false;
  return (req.runtime.unmet_prerequisites?.get(capabilityId) ?? undefined) === undefined;
}

/** Capabilities the browser recipe will emit for this candidate. */
function requiredForBrowserRecipe(req: CompileRequest): string[] {
  const mapped = new Set(req.candidate.canonical_sequence.flatMap((t) => capabilitiesForToken(t)));
  const required = ["browser.extract_structured_fields"];
  if (mapped.has("browser.extract_table")) required.push("browser.extract_table");
  if (mapped.has("browser.supervised_form_fill")) {
    required.push("browser.propose_form_fill", "browser.supervised_form_fill");
  }
  return required;
}

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
 * Evidence that the observed workflow actually HAS a tabular data source and a
 * CRM destination — the two halves the reconciliation recipe wires together.
 * The recipe's shape (parse a file → match rows → update Salesforce) is only
 * honest when both halves were seen.
 */
function looksLikeReconciliation(req: CompileRequest): boolean {
  const parts = req.candidate.canonical_sequence.map((t) => {
    const [, category = "-", eventType = "-"] = t.split(":");
    return { category, eventType };
  });
  const hasTabularSource = parts.some(
    (p) => p.category === "spreadsheet" || p.eventType === "table_read",
  );
  const hasCrmDestination = parts.some((p) => p.category === "crm");
  return hasTabularSource && hasCrmDestination;
}

/**
 * The primary demo recipe: account-list reconciliation (spec §24 exactly).
 *
 * MATCHES ON EVIDENCE, NOT INTENT ALONE. It previously accepted any
 * `update_<object>_records` intent — so a live-observed CRM edit pattern (a
 * user retyping two fields in Salesforce, no spreadsheet, no file anywhere)
 * compiled into THIS recipe: a CSV-parsing, row-matching agent demanding an
 * `account_csv` input the user never mentioned, whose steps 1, 2, 4 and 7 the
 * user never performed. An ERP invoice workflow did the same. The suggestion
 * card then described a workflow the compiled agent does not implement.
 *
 * The split is explicit-vs-derived:
 * - `reconcile_account_list` is the recipe's own name — an EXPLICIT selection
 *   (the naming layer only derives it from crm+spreadsheet evidence, and a
 *   teach/configure flow sets it deliberately). It always matches.
 * - `update_<object>_records` is DERIVED from any CRM-edit pattern, so it
 *   additionally requires the observed sequence to contain a tabular source
 *   AND a CRM destination. CRM edits without a seen source are a real
 *   automation opportunity — but the missing half must be TAUGHT, so they
 *   return `needs_configuration` (below) instead of an unrelated agent.
 */
const RECONCILIATION_RECIPE: Recipe = {
  id: "reconciliation-v1",
  matches: (intent, req) =>
    intent === "reconcile_account_list" ||
    (UPDATE_RECORDS_INTENT.test(intent) && looksLikeReconciliation(req)),
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

/** Intents the deterministic naming derives for live-observed workflows with
 * no recognisable business shape: automate_<object>_workflow. */
const BROWSER_WORKFLOW_INTENT = /^automate_([a-z0-9_]+)_workflow$/;

/**
 * Live-observed browser workflows — the shape the macOS AX observer actually
 * produces (browser category, element_focused / value_committed, no object
 * nouns). Before this recipe existed, "Try it" on every live browser card
 * failed with C-NO-PLAN: the only recipe matched CRM reconciliation intents,
 * and the constrained model draft has nothing to add for an anonymous page.
 *
 * The recipe compiles the canonical supervised-browser shape rather than
 * echoing the raw event sequence: read the page's fields, propose the fill,
 * apply it once after explicit approval, then re-read to verify (independent
 * read — the run engine's verification story). A sequence whose mapped
 * capabilities are read-only compiles to just the read step: a helper that
 * extracts and changes nothing.
 *
 * Scope guard: every mapped capability must be browser.* — a flow that mixes
 * in spreadsheet or CRM work is NOT safely covered by this shape and stays
 * blocked (honest) rather than compiling a helper that ignores half the work.
 */
const BROWSER_WORKFLOW_RECIPE: Recipe = {
  id: "browser-workflow-v1",
  matches: (intent, req) => {
    if (!BROWSER_WORKFLOW_INTENT.test(intent)) return false;
    const mapped = req.candidate.canonical_sequence.flatMap((t) => capabilitiesForToken(t));
    if (mapped.length === 0 || !mapped.every((id) => id.startsWith("browser."))) return false;
    // A recipe must not emit steps the target runtime cannot execute. Without
    // this the write branch below produced browser.propose_form_fill and
    // browser.supervised_form_fill, which NO adapter registry implements, and
    // the desktop run path passed the resulting `undefined` adapter into the
    // run engine — a TypeError mid-run instead of an honest refusal.
    return requiredForBrowserRecipe(req).every((id) => runtimeHas(req, id));
  },
  build: (req) => {
    const mapped = new Set(
      req.candidate.canonical_sequence.flatMap((t) => capabilitiesForToken(t)),
    );
    const writes = mapped.has("browser.supervised_form_fill");

    const steps: AgentStep[] = [
      step(
        1,
        "read-page",
        "Read the fields on the open page",
        "browser.extract_structured_fields",
        "read",
        { page: { source: "literal", value: "current_page" } },
        "page_fields",
      ),
    ];
    if (mapped.has("browser.extract_table")) {
      steps.push(
        step(
          steps.length + 1,
          "read-table",
          "Read the table on the open page",
          "browser.extract_table",
          "read",
          { page: { source: "literal", value: "current_page" } },
          "page_table",
        ),
      );
    }
    if (writes) {
      steps.push(
        step(
          steps.length + 1,
          "propose-fill",
          "Propose the form fill",
          "browser.propose_form_fill",
          "propose_write",
          { fields: { source: "step_output", ref: "page_fields" } },
          "proposed_fill",
        ),
        step(
          steps.length + 2,
          "apply-fill",
          "Fill the form, once, after your approval",
          "browser.supervised_form_fill",
          "write",
          { proposal: { source: "step_output", ref: "proposed_fill" } },
          "fill_result",
          { approval: { required: true, reason: "supervised browser write" } },
        ),
        step(
          steps.length + 3,
          "verify-read",
          "Re-read the page to verify the change",
          "browser.extract_structured_fields",
          "read",
          {
            page: { source: "literal", value: "current_page" },
            after: { source: "step_output", ref: "fill_result" },
          },
          "verification_fields",
        ),
      );
    }
    return { inputs: [], steps, assertions: [] };
  },
};

const RECIPES: Recipe[] = [RECONCILIATION_RECIPE, BROWSER_WORKFLOW_RECIPE];

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
  const recipe = RECIPES.find((r) => r.matches(req.generalized_intent, req));
  if (recipe) {
    const result = finalize(req, recipe.build(req), "recipe", recipe.id, [], usages, nameCopy);
    // Final gate: even a matched recipe must not produce a spec this runtime
    // cannot execute. Checked on the BUILT spec, so it covers every step
    // actually emitted rather than what the matcher predicted.
    if (result.status === "valid" && req.runtime) {
      const readiness = validateRuntimeCapabilities(result.spec, req.runtime);
      if (!readiness.ready) {
        return {
          status: "needs_runtime",
          runtime_id: readiness.runtime_id,
          missing: readiness.missing,
          message: describeMissingCapabilities(readiness.missing),
        };
      }
    }
    return result;
  }

  // A CRM update pattern whose data source was never observed. The old
  // behaviour compiled the reconciliation recipe anyway; the honest answer is
  // that the SOURCE of the new values is exactly what observation could not
  // see, and the user has to teach it.
  if (UPDATE_RECORDS_INTENT.test(req.generalized_intent) && !looksLikeReconciliation(req)) {
    return {
      status: "needs_configuration",
      missing: [
        {
          kind: "data_source",
          detail:
            "I watched you update records, but I never saw where the new values come from — a file, a spreadsheet, another system, or your own judgment.",
        },
        {
          kind: "field_mapping",
          detail: "Which source values map onto which record fields.",
        },
      ],
      message:
        "I can see this workflow updates records, but not where the new values come from. Teach me the source and the field mapping, and I can draft it.",
    };
  }

  // A browser workflow whose recipe declined ONLY because the runtime lacks an
  // adapter must say so, rather than falling through to "I couldn't safely
  // draft this" (which sends the user to reconfigure a workflow that is fine).
  if (req.runtime && BROWSER_WORKFLOW_INTENT.test(req.generalized_intent)) {
    const unavailable = requiredForBrowserRecipe(req).filter((id) => !runtimeHas(req, id));
    if (unavailable.length > 0) {
      const missing: MissingCapability[] = unavailable.map((id) => ({
        capability_id: id,
        step_id: "-",
        reason: req.runtime!.available.has(id) ? "prerequisite_unmet" : "no_adapter",
        detail:
          req.runtime!.unmet_prerequisites?.get(id) ??
          `${req.runtime!.runtime_id} has no adapter for ${id}`,
      }));
      return {
        status: "needs_runtime",
        runtime_id: req.runtime.runtime_id,
        missing,
        message: describeMissingCapabilities(missing),
      };
    }
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
      const result = finalize(
        req,
        built,
        "model",
        "model",
        [
          // The propose-only rule (model drafts never receive direct write
          // steps) is a safety property, but it must be VISIBLE — a user whose
          // workflow writes should know this draft will only propose until a
          // human elevates it.
          "Drafted by a model: every step proposes only; nothing is written until you elevate and approve it.",
        ],
        [...usages, draft.usage],
        nameCopy,
      );
      if (result.status !== "valid") continue;
      // The model path must not bypass the runtime gate the recipe path has:
      // a model plan referencing an adapter-less capability is just as
      // unexecutable as a recipe doing so.
      if (req.runtime) {
        const readiness = validateRuntimeCapabilities(result.spec, req.runtime);
        if (!readiness.ready) {
          return {
            status: "needs_runtime",
            runtime_id: readiness.runtime_id,
            missing: readiness.missing,
            message: describeMissingCapabilities(readiness.missing),
          };
        }
      }
      return result;
    }
  }

  // Unknown workflow: typed as "needs configuration", because that is what it
  // is — nothing about the workflow is prohibited, we simply were not taught
  // enough to compile it. The previous generic `blocked` (C-NO-PLAN) read as a
  // dead end and gave the user nothing actionable.
  return {
    status: "needs_configuration",
    missing: [
      {
        kind: "workflow_definition",
        detail:
          "No safe recipe covers this workflow, and observation alone did not capture its targets, inputs and success conditions.",
      },
    ],
    message:
      "I don't know how to do this workflow safely yet. Walk me through it once — which fields, which values, and what a successful result looks like — and I can draft it.",
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
  recipeId: string,
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
    compiled_from: {
      pattern_id: req.candidate.pattern_id,
      generalized_intent: req.generalized_intent,
      recipe: recipeId,
    },
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
