import { describe, expect, it } from "vitest";
import { uuidv7, type PatternCandidate } from "@maman/contracts";
import { DEFAULT_ORG_POLICY } from "@maman/policy-engine";
import { compileAgentSpec, type CompileRequest } from "../src/compiler.js";
import { demoAdapterRegistry, DemoSalesforceWorld } from "../src/adapters.js";
import { runtimeFromRegistry } from "../src/runtime-capabilities.js";

/**
 * THE WRONG-AGENT REGRESSION (Phase 3).
 *
 * The reconciliation recipe matched ANY `update_<object>_records` intent, so a
 * live-observed CRM edit (a user retyping two fields in Salesforce — no
 * spreadsheet, no file anywhere) compiled into a CSV-parsing, row-matching
 * agent that DEMANDED an `account_csv` input the user never mentioned, and
 * whose steps 1, 2, 4 and 7 the user never performed. An ERP invoice workflow
 * did the same. The card described one workflow; the agent implemented another.
 *
 * The rule: a recipe fires on an explicit selection of its own name, or on
 * observed EVIDENCE of its shape — never on an intent string alone.
 */

function candidate(sequence: string[]): PatternCandidate {
  return {
    pattern_id: uuidv7(),
    owner_user_id: uuidv7(),
    first_seen_at: "2026-08-01T09:00:00.000Z",
    last_seen_at: "2026-08-05T09:00:00.000Z",
    occurrence_count: 8,
    distinct_day_count: 4,
    median_duration_ms: 300_000,
    p90_duration_ms: 400_000,
    canonical_sequence: sequence,
    episode_ids: [],
    similarity_mean: 0.95,
    repeatability_score: 0.9,
    feasibility_score: 0.8,
    risk_score: 0.3,
    projected_minutes_saved_weekly: 40,
    opportunity_score: 0.7,
    status: "eligible",
  };
}

function request(over: Partial<CompileRequest> = {}): CompileRequest {
  return {
    candidate: candidate([]),
    generalized_intent: "reconcile_account_list",
    desired_outcome: "Reconcile the account list with Salesforce.",
    organization_id: uuidv7(),
    owner_user_id: uuidv7(),
    budgets: {
      max_runtime_seconds: 300,
      max_model_tokens: 12_000,
      max_cost_usd: 1,
      max_records_read: 1000,
      max_records_written: 20,
    },
    policy: DEFAULT_ORG_POLICY,
    policy_version_id: uuidv7(),
    now: () => new Date("2026-08-07T06:00:00.000Z"),
    ...over,
  };
}

/** The evidence the reconciliation shape genuinely describes. */
const RECONCILIATION_EVIDENCE = [
  "chrome:spreadsheet:table_read:grid:account_list:account",
  "chrome:crm:record_opened:row:account:account",
  "chrome:crm:record_updated:field:account_field:account",
];

/** A CRM-only edit pattern: destination seen, source never seen. */
const CRM_EDITS_ONLY = [
  "chrome:crm:navigation:row:-:account",
  "chrome:crm:element_activated:searchbox:-:account",
  "chrome:crm:value_committed:input:account_name:account",
  "chrome:crm:value_committed:input:account_phone:account",
];

/** An ERP invoice workflow — nothing to do with CSVs or Salesforce accounts. */
const ERP_INVOICES = [
  "chrome:erp:record_opened:row:invoice:invoice",
  "chrome:erp:record_updated:field:invoice_field:invoice",
];

describe("no accidental reconciliation fallback", () => {
  it("an observed CRM edit with no seen source is needs_configuration, not a CSV agent", async () => {
    // THE live-arc pathology: this is liveWorkflowRepFixture's exact shape.
    const result = await compileAgentSpec(
      request({
        candidate: candidate(CRM_EDITS_ONLY),
        generalized_intent: "update_account_records",
      }),
    );
    expect(result.status).toBe("needs_configuration");
    if (result.status !== "needs_configuration") return;
    // The missing piece is named: the data source observation never saw.
    expect(result.missing.map((m) => m.kind)).toContain("data_source");
    expect(result.message).toMatch(/where the new values come from/);
  });

  it("an ERP invoice workflow can never become a Salesforce reconciliation agent", async () => {
    const result = await compileAgentSpec(
      request({
        candidate: candidate(ERP_INVOICES),
        generalized_intent: "update_invoice_records",
      }),
    );
    expect(result.status).toBe("needs_configuration");
    if (result.status === "valid") {
      throw new Error("compiled the wrong agent");
    }
  });

  it("never invents an input the user was never observed to provide", async () => {
    const result = await compileAgentSpec(
      request({
        candidate: candidate(CRM_EDITS_ONLY),
        generalized_intent: "update_account_records",
      }),
    );
    // The old behaviour's tell: a required account_csv from nowhere.
    expect(result.status).not.toBe("valid");
  });
});

describe("explicit recipe matches still compile", () => {
  it("compiles the explicitly selected reconciliation workflow", async () => {
    const result = await compileAgentSpec(
      request({ candidate: candidate(RECONCILIATION_EVIDENCE) }),
    );
    expect(result.status).toBe("valid");
    if (result.status !== "valid") return;
    expect(result.compiled_from.recipe).toBe("reconciliation-v1");
    expect(result.spec.steps.some((s) => s.capability_id === "salesforce.update_fields")).toBe(
      true,
    );
  });

  it("compiles a DERIVED update intent when the evidence really has both halves", async () => {
    const result = await compileAgentSpec(
      request({
        candidate: candidate(RECONCILIATION_EVIDENCE),
        generalized_intent: "update_account_records",
      }),
    );
    expect(result.status).toBe("valid");
  });

  it("compiles the explicitly matched browser workflow — and never the CRM recipe", async () => {
    const result = await compileAgentSpec(
      request({
        candidate: candidate([
          "macos_ax:browser:element_focused:AXGroup:-:-",
          "macos_ax:browser:value_committed:AXTextField:-:-",
        ]),
        generalized_intent: "automate_record_workflow",
      }),
    );
    expect(result.status).toBe("valid");
    if (result.status !== "valid") return;
    expect(result.compiled_from.recipe).toBe("browser-workflow-v1");
    // The intent selection cannot leak into the Salesforce recipe.
    expect(result.spec.steps.some((s) => s.capability_id.startsWith("salesforce."))).toBe(false);
    expect(result.spec.inputs.find((i) => i.key === "account_csv")).toBeUndefined();
  });
});

describe("typed refusals", () => {
  it("an unknown workflow is needs_configuration with a workflow_definition gap", async () => {
    const result = await compileAgentSpec(
      request({ generalized_intent: "some_entirely_new_thing" }),
    );
    expect(result.status).toBe("needs_configuration");
    if (result.status !== "needs_configuration") return;
    expect(result.missing[0]!.kind).toBe("workflow_definition");
  });

  it("a model plan cannot bypass the runtime availability check", async () => {
    // The model proposes a plan using a capability the runtime has no adapter
    // for. The recipe path is gated; the model path must be too.
    const model = {
      id: "demo" as const,
      nameRecommendation: async () => ({ ok: false as const, error: "unavailable" as const }),
      draftAgentPlan: async () => ({
        ok: true as const,
        value: { intent: "x", steps: [{ order: 1, capability_id: "browser.extract_table" }] },
        usage: { input_tokens: 10, output_tokens: 10, model_alias: "demo" },
      }),
    };
    // A runtime WITHOUT browser.extract_table:
    const runtime = runtimeFromRegistry(
      "no-browser",
      new Map([["salesforce.query_records", { read: () => undefined }]]),
    );
    const result = await compileAgentSpec(
      request({ generalized_intent: "unknown_custom_intent", model, runtime }),
    );
    expect(result.status).toBe("needs_runtime");
    if (result.status !== "needs_runtime") return;
    expect(result.missing[0]!.capability_id).toBe("browser.extract_table");
  });

  it("a write demoted to a propose its adapter cannot perform is REFUSED, not shipped", async () => {
    // The model demotes salesforce.update_fields to propose_write (drafts never
    // get direct writes), but the demo adapter for update_fields implements
    // only write() — the demoted step would be a nonfunctional propose-only
    // stub. The runtime mode check refuses it instead of compiling a step that
    // can never execute.
    const model = {
      id: "demo" as const,
      nameRecommendation: async () => ({ ok: false as const, error: "unavailable" as const }),
      draftAgentPlan: async () => ({
        ok: true as const,
        value: {
          intent: "x",
          steps: [{ order: 1, capability_id: "salesforce.update_fields" }],
        },
        usage: { input_tokens: 10, output_tokens: 10, model_alias: "demo" },
      }),
    };
    const runtime = runtimeFromRegistry(
      "local-demo",
      demoAdapterRegistry(new DemoSalesforceWorld()),
    );
    const result = await compileAgentSpec(
      request({ generalized_intent: "unknown_custom_intent", model, runtime }),
    );
    expect(result.status).toBe("needs_runtime");
    if (result.status !== "needs_runtime") return;
    expect(result.missing[0]!.reason).toBe("mode_unsupported");
  });

  it("a model-compiled plan is labeled propose-only, never silently write-capable", async () => {
    const model = {
      id: "demo" as const,
      nameRecommendation: async () => ({ ok: false as const, error: "unavailable" as const }),
      draftAgentPlan: async () => ({
        ok: true as const,
        value: {
          intent: "x",
          // A capability whose adapter genuinely implements propose_write.
          steps: [{ order: 1, capability_id: "salesforce.propose_field_updates" }],
        },
        usage: { input_tokens: 10, output_tokens: 10, model_alias: "demo" },
      }),
    };
    const runtime = runtimeFromRegistry(
      "local-demo",
      demoAdapterRegistry(new DemoSalesforceWorld()),
    );
    const result = await compileAgentSpec(
      request({ generalized_intent: "unknown_custom_intent", model, runtime }),
    );
    if (result.status !== "valid") throw new Error(`expected valid, got ${result.status}`);
    expect(result.spec.steps.every((s) => s.mode !== "write")).toBe(true);
    // …and the propose-only nature is stated, not hidden.
    expect(result.warnings.some((w) => /proposes only/.test(w))).toBe(true);
    expect(result.compiled_from.recipe).toBe("model");
  });

  it("records the audit trail from pattern to recipe on every valid compile", async () => {
    const req = request({ candidate: candidate(RECONCILIATION_EVIDENCE) });
    const result = await compileAgentSpec(req);
    if (result.status !== "valid") throw new Error("expected valid");
    expect(result.compiled_from).toEqual({
      pattern_id: req.candidate.pattern_id,
      generalized_intent: "reconcile_account_list",
      recipe: "reconciliation-v1",
    });
    // The spec itself carries the pattern link for persistence.
    expect(result.spec.source_pattern_id).toBe(req.candidate.pattern_id);
  });
});
