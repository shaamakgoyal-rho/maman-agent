import { describe, expect, it } from "vitest";
import {
  compareShadowRun,
  DEFAULT_REQUIRED_COMPARISONS,
  evaluateMeshTransition,
  meshToAgentState,
  promotionReadiness,
  type ShadowComparison,
} from "../src/index.js";
import { executionReceiptSchema, petReceiptSummary, uuidv7 } from "@maman/contracts";

describe("mesh lifecycle", () => {
  it("follows the ten-state journey in order", () => {
    const agreement = { successful_comparisons: 3, required_comparisons: 3 };
    const journey = [
      ["observed", "candidate_detected", "system"],
      ["candidate_detected", "connector_suggested", "system"],
      ["connector_suggested", "shadowing", "user"],
      ["shadowing", "draft_agent", "user"],
      ["draft_agent", "supervised", "user"],
      ["supervised", "approved", "user"],
    ] as const;
    for (const [from, to, actor] of journey) {
      const result = evaluateMeshTransition({ from, to, actor, shadow_agreement: agreement });
      expect(result.allowed, `${from} → ${to}`).toBe(true);
    }
  });

  it("confidence alone NEVER promotes — system actors are blocked at human gates", () => {
    const result = evaluateMeshTransition({
      from: "supervised",
      to: "approved",
      actor: "system",
      shadow_agreement: { successful_comparisons: 100, required_comparisons: 3 },
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toMatch(/human decision/);
  });

  it("autonomy requires approval AND org policy", () => {
    expect(
      evaluateMeshTransition({
        from: "approved",
        to: "autonomous",
        actor: "admin",
        org_policy_allows_autonomy: true,
      }).allowed,
    ).toBe(true);
    expect(
      evaluateMeshTransition({ from: "approved", to: "autonomous", actor: "admin" }).allowed,
    ).toBe(false);
    expect(
      evaluateMeshTransition({
        from: "approved",
        to: "autonomous",
        actor: "system",
        org_policy_allows_autonomy: true,
      }).allowed,
    ).toBe(false);
  });

  it("shadow → draft requires the configured number of successful comparisons", () => {
    expect(
      evaluateMeshTransition({
        from: "shadowing",
        to: "draft_agent",
        actor: "user",
        shadow_agreement: { successful_comparisons: 2, required_comparisons: 3 },
      }).allowed,
    ).toBe(false);
    expect(
      evaluateMeshTransition({ from: "shadowing", to: "draft_agent", actor: "user" }).allowed,
    ).toBe(false);
  });

  it("retired is terminal; paused can resume", () => {
    expect(
      evaluateMeshTransition({ from: "retired", to: "observed", actor: "admin" }).allowed,
    ).toBe(false);
    expect(
      evaluateMeshTransition({ from: "paused", to: "supervised", actor: "user" }).allowed,
    ).toBe(true);
  });

  it("maps every mesh state to a core agent state", () => {
    expect(meshToAgentState("shadowing")).toBe("shadow");
    expect(meshToAgentState("autonomous")).toBe("active");
    expect(meshToAgentState("retired")).toBe("archived");
    expect(meshToAgentState("connector_suggested")).toBe("draft");
  });
});

describe("shadow comparisons", () => {
  const change = (field: string, hash = "h1") => ({
    object_ref: "obj_abcdef1234567890",
    field,
    proposed_value_hash: hash,
  });

  it("full agreement scores 1 and no writes exist by construction", () => {
    const comparison = compareShadowRun(
      "r1",
      [change("owner"), change("segment")],
      [change("owner"), change("segment")],
    );
    expect(comparison.agreement).toBe(1);
    expect(comparison.missing_rules).toEqual([]);
    // the type admits proposals only — nothing here can represent a completed write
    expect(JSON.stringify(comparison)).not.toMatch(/completed|written/);
  });

  it("identifies missed rules the user applied but the shadow did not", () => {
    const comparison = compareShadowRun(
      "r1",
      [change("owner")],
      [change("owner"), change("employee_count")],
    );
    expect(comparison.missed).toBe(1);
    expect(comparison.missing_rules[0]).toMatch(/employee_count/);
    expect(comparison.agreement).toBeLessThan(1);
  });

  it("flags extra proposals the user never made", () => {
    const comparison = compareShadowRun(
      "r1",
      [change("owner"), change("website")],
      [change("owner")],
    );
    expect(comparison.extra).toBe(1);
    expect(comparison.missing_rules.some((r) => r.includes("website"))).toBe(true);
  });

  it("empty vs empty agrees perfectly", () => {
    expect(compareShadowRun("r1", [], []).agreement).toBe(1);
  });

  it("promotion readiness needs N successes at >=0.9 agreement", () => {
    const success: ShadowComparison = {
      run_id: "a",
      agreement: 0.95,
      matched: 9,
      missed: 0,
      extra: 1,
      missing_rules: [],
    };
    const failure: ShadowComparison = {
      run_id: "b",
      agreement: 0.5,
      matched: 1,
      missed: 1,
      extra: 0,
      missing_rules: [],
    };
    expect(promotionReadiness([success, failure, success]).ready).toBe(false);
    expect(promotionReadiness([success, success, success]).ready).toBe(true);
    expect(promotionReadiness([success], 1).ready).toBe(true);
    expect(DEFAULT_REQUIRED_COMPARISONS).toBe(3);
  });
});

describe("execution receipts", () => {
  const receipt = () =>
    executionReceiptSchema.parse({
      schema_version: 1,
      receipt_id: uuidv7(),
      run_id: uuidv7(),
      agent_id: uuidv7(),
      agent_version_id: uuidv7(),
      recipe_version: 1,
      trigger: "manual",
      mode: "supervised",
      started_at: "2026-07-17T18:00:00.000Z",
      completed_at: "2026-07-17T18:02:00.000Z",
      steps: [
        {
          step_id: "apply-updates",
          capability_id: "salesforce.update_fields",
          source: "api",
          records_read: 10,
          writes_proposed: 14,
          writes_completed: 14,
          verification: "independent_read_passed",
          duration_ms: 4_000,
          retries: 0,
        },
      ],
      approvals: [
        {
          step_id: "apply-updates",
          approver_user_id: uuidv7(),
          decided_at: "2026-07-17T18:01:00.000Z",
          decision: "approved",
        },
      ],
      totals: {
        records_read: 10,
        writes_proposed: 14,
        writes_completed: 14,
        duration_ms: 120_000,
        model_input_tokens: 900,
        model_output_tokens: 220,
        model_cost_usd: 0.01,
        provider_cost_usd: 0.07,
        total_cost_usd: 0.08,
      },
      roi: {
        manual_baseline_ms: 20 * 60_000,
        baseline_provenance: "measured",
        baseline_observation_count: 6,
        gross_time_saved_ms: 18 * 60_000,
        human_review_ms: 60_000,
        net_time_saved_ms: 17 * 60_000,
        savings_provenance: "measured",
      },
      outcome: "completed",
    });

  it("validates and rejects unknown fields", () => {
    expect(receipt()).toBeTruthy();
    expect(executionReceiptSchema.safeParse({ ...receipt(), secret_notes: "x" }).success).toBe(
      false,
    );
  });

  it("pet summary matches the human phrasing contract", () => {
    const summary = petReceiptSummary(receipt());
    expect(summary).toContain("Updated 14 records.");
    expect(summary).toContain("You reviewed 1 step.");
    expect(summary).toContain("Saved approximately 17 minutes.");
    expect(summary).toContain("Execution cost: $0.08.");
  });

  it("estimated savings are clearly qualified, never presented as confirmed", () => {
    const estimated = {
      ...receipt(),
      roi: {
        ...receipt().roi,
        savings_provenance: "estimated" as const,
        baseline_observation_count: 1,
      },
    };
    const summary = petReceiptSummary(executionReceiptSchema.parse(estimated));
    expect(summary).toContain("Estimated (unconfirmed) savings:");
    expect(summary).not.toContain("Saved approximately");
  });

  it("shadow receipts state that nothing was written", () => {
    const shadow = {
      ...receipt(),
      mode: "shadow" as const,
      totals: { ...receipt().totals, writes_completed: 0 },
      approvals: [],
    };
    const summary = petReceiptSummary(executionReceiptSchema.parse(shadow));
    expect(summary).toContain("wrote nothing");
  });
});
