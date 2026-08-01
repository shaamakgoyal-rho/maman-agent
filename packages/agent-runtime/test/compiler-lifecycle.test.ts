import { describe, expect, it } from "vitest";
import { uuidv7, type PatternCandidate } from "@maman/contracts";
import { DEFAULT_ORG_POLICY } from "@maman/policy-engine";
import { DemoModelProvider } from "@maman/model-provider";
import { compileAgentSpec, type CompileRequest } from "../src/compiler.js";
import { canTransition, evaluateTransition, stateAfterMaterialEdit } from "../src/lifecycle.js";
import { validateAgentSpec } from "../src/validator.js";

function candidate(): PatternCandidate {
  return {
    pattern_id: uuidv7(),
    owner_user_id: uuidv7(),
    first_seen_at: "2026-07-14T09:40:00.000Z",
    last_seen_at: "2026-07-16T15:00:00.000Z",
    occurrence_count: 6,
    distinct_day_count: 3,
    median_duration_ms: 660_000,
    p90_duration_ms: 780_000,
    canonical_sequence: [
      "chrome:spreadsheet:table_read:grid:account_list:account",
      "chrome:crm:record_opened:row:account:account",
      "chrome:crm:record_updated:field:account_field:account",
    ],
    episode_ids: [],
    similarity_mean: 0.9,
    repeatability_score: 0.9,
    feasibility_score: 0.8,
    risk_score: 0.3,
    projected_minutes_saved_weekly: 70,
    opportunity_score: 0.72,
    status: "eligible",
  };
}

function request(overrides: Partial<CompileRequest> = {}): CompileRequest {
  return {
    candidate: candidate(),
    generalized_intent: "reconcile_account_list",
    desired_outcome: "Match rows by company domain and propose Salesforce Account updates.",
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
    now: () => new Date("2026-07-17T18:00:00.000Z"),
    ...overrides,
  };
}

describe("compiler (M6 gate)", () => {
  it("the demo recommendation compiles to a schema-valid draft via the recipe", async () => {
    const result = await compileAgentSpec(request());
    expect(result.status).toBe("valid");
    if (result.status !== "valid") return;
    expect(result.compiled_by).toBe("recipe");
    expect(result.spec.state).toBe("draft"); // never silently active
    expect(result.spec.created_by).toBe("compiler");
    expect(validateAgentSpec(result.spec).valid).toBe(true);
    // Expected seven-step reconciliation plan (spec §24)
    expect(result.spec.steps.map((s) => s.capability_id)).toEqual([
      "local.parse_csv",
      "local.transform_columns",
      "salesforce.query_records",
      "local.match_records",
      "salesforce.propose_field_updates",
      "salesforce.update_fields",
      "local.generate_csv",
    ]);
    // The single write step demands approval.
    const write = result.spec.steps.find((s) => s.mode === "write")!;
    expect(write.approval.required).toBe(true);
    // Plain-language plan surfaces the approval point and limits.
    expect(result.plain_language_plan.join("\n")).toMatch(/WAITS FOR YOUR APPROVAL/);
    expect(result.plain_language_plan.join("\n")).toMatch(/at most 20 records/);
    expect(result.policy_decision.decision).toBe("require_approval");
  });

  it("uses only catalog capability ids", async () => {
    const result = await compileAgentSpec(request());
    if (result.status !== "valid") throw new Error("expected valid");
    for (const step of result.spec.steps) {
      expect(step.capability_id).toMatch(
        /^(local|salesforce|google_sheets|gmail|google_calendar|browser)\./,
      );
    }
  });

  it("is deterministic", async () => {
    const a = await compileAgentSpec(request({ candidate: candidate() }));
    const b = await compileAgentSpec(request({ candidate: candidate() }));
    if (a.status !== "valid" || b.status !== "valid") throw new Error("expected valid");
    expect(a.spec.steps).toEqual(b.spec.steps);
    expect(a.plain_language_plan).toEqual(b.plain_language_plan);
  });

  it("over-budget requests are blocked by policy", async () => {
    const result = await compileAgentSpec(
      request({
        budgets: {
          max_runtime_seconds: 300,
          max_model_tokens: 12_000,
          max_cost_usd: 999, // above org per-run limit
          max_records_read: 1000,
          max_records_written: 20,
        },
      }),
    );
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.issues.some((i) => i.rule === "P-BUDGET-3")).toBe(true);
    }
  });

  it("prohibited/unknown intents without a model are blocked with a safe message", async () => {
    const result = await compileAgentSpec(request({ generalized_intent: "unknown_thing" }));
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.message).toMatch(/couldn't safely draft/);
    }
  });

  it("model drafts are constrained: arbitrary tools are rejected (prompt injection)", async () => {
    // A hostile model returns tools that were never offered.
    const hostileModel = {
      id: "demo" as const,
      nameRecommendation: new DemoModelProvider().nameRecommendation.bind(new DemoModelProvider()),
      draftAgentPlan: async () => ({
        ok: true as const,
        value: {
          intent: "x",
          steps: [
            { order: 1, capability_id: "shell.execute" },
            { order: 2, capability_id: "gmail.send" },
          ],
        },
        usage: { input_tokens: 0, output_tokens: 0, model_alias: "hostile" },
      }),
    };
    const result = await compileAgentSpec(
      request({ generalized_intent: "unknown_thing", model: hostileModel }),
    );
    // The unknown capabilities cannot enter a spec — compilation is blocked.
    expect(result.status).toBe("blocked");
  });

  it("model drafts never receive direct write steps", async () => {
    const model = {
      id: "demo" as const,
      nameRecommendation: new DemoModelProvider().nameRecommendation.bind(new DemoModelProvider()),
      draftAgentPlan: async () => ({
        ok: true as const,
        value: {
          intent: "x",
          steps: [{ order: 1, capability_id: "salesforce.update_fields" }],
        },
        usage: { input_tokens: 0, output_tokens: 0, model_alias: "demo" },
      }),
    };
    const result = await compileAgentSpec(request({ generalized_intent: "unknown_thing", model }));
    if (result.status === "valid") {
      expect(result.spec.steps.every((s) => s.mode !== "write")).toBe(true);
    } else {
      // blocked is also acceptable — but never a direct write
      expect(result.status).toBe("blocked");
    }
  });
});

describe("agent lifecycle (spec §13)", () => {
  it("allows exactly the locked transitions", () => {
    expect(canTransition("draft", "shadow")).toBe(true);
    expect(canTransition("shadow", "draft")).toBe(true);
    expect(canTransition("shadow", "supervised")).toBe(true);
    expect(canTransition("supervised", "shadow")).toBe(true);
    expect(canTransition("supervised", "active")).toBe(true);
    expect(canTransition("active", "paused")).toBe(true);
    expect(canTransition("paused", "active")).toBe(true);
    expect(canTransition("degraded", "shadow")).toBe(true);
    // forbidden jumps
    expect(canTransition("draft", "active")).toBe(false);
    expect(canTransition("draft", "supervised")).toBe(false);
    expect(canTransition("shadow", "active")).toBe(false);
    // terminal states
    expect(canTransition("revoked", "shadow")).toBe(false);
    expect(canTransition("archived", "draft")).toBe(false);
  });

  it("any nonarchived state can degrade, revoke, and archive", () => {
    for (const from of ["draft", "shadow", "supervised", "active", "paused"] as const) {
      expect(canTransition(from, "degraded")).toBe(true);
      expect(canTransition(from, "revoked")).toBe(true);
      expect(canTransition(from, "archived")).toBe(true);
    }
  });

  it("only a user may promote shadow → supervised", () => {
    expect(evaluateTransition({ from: "shadow", to: "supervised", actor: "user" }).allowed).toBe(
      true,
    );
    expect(evaluateTransition({ from: "shadow", to: "supervised", actor: "system" }).allowed).toBe(
      false,
    );
  });

  it("supervised → active needs user AND org policy", () => {
    expect(
      evaluateTransition({
        from: "supervised",
        to: "active",
        actor: "user",
        org_policy_allows_activation: true,
      }).allowed,
    ).toBe(true);
    expect(evaluateTransition({ from: "supervised", to: "active", actor: "user" }).allowed).toBe(
      false,
    );
    expect(
      evaluateTransition({
        from: "supervised",
        to: "active",
        actor: "policy",
        org_policy_allows_activation: true,
      }).allowed,
    ).toBe(false);
  });

  it("material edits always return the agent to shadow", () => {
    for (const from of ["shadow", "supervised", "active", "paused"] as const) {
      expect(stateAfterMaterialEdit(from)).toBe("shadow");
    }
  });
});

describe("derived-intent recipe matching (live-detected patterns)", () => {
  it("update_account_records compiles via the deterministic recipe", async () => {
    const result = await compileAgentSpec(
      request({ generalized_intent: "update_account_records" }),
    );
    expect(result.status).toBe("valid");
    if (result.status !== "valid") return;
    expect(result.compiled_by).toBe("recipe");
    const query = result.spec.steps.find((s) => s.capability_id === "salesforce.query_records")!;
    expect(query.inputs["object"]).toEqual({ source: "literal", value: "Account" });
    // Same safe shape: single approval-gated write.
    const write = result.spec.steps.find((s) => s.mode === "write")!;
    expect(write.approval.required).toBe(true);
  });

  it("the queried object follows the intent (update_opportunity_records → Opportunity)", async () => {
    const result = await compileAgentSpec(
      request({ generalized_intent: "update_opportunity_records" }),
    );
    expect(result.status).toBe("valid");
    if (result.status !== "valid") return;
    expect(result.compiled_by).toBe("recipe");
    const query = result.spec.steps.find((s) => s.capability_id === "salesforce.query_records")!;
    expect(query.inputs["object"]).toEqual({ source: "literal", value: "Opportunity" });
  });

  it("an unknown-object update intent falls back to Account, never garbage", async () => {
    const result = await compileAgentSpec(request({ generalized_intent: "update_record_records" }));
    expect(result.status).toBe("valid");
    if (result.status !== "valid") return;
    const query = result.spec.steps.find((s) => s.capability_id === "salesforce.query_records")!;
    expect(query.inputs["object"]).toEqual({ source: "literal", value: "Account" });
  });

  it("a non-CRM intent still routes to the model path, not the recipe", async () => {
    const result = await compileAgentSpec(
      request({ generalized_intent: "generate_account_report", model: new DemoModelProvider() }),
    );
    // Demo model path produces an inert-but-valid or blocked result — never the recipe.
    if (result.status === "valid") expect(result.compiled_by).toBe("model");
  });
});
