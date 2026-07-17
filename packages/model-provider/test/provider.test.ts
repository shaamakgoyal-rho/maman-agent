import { describe, expect, it } from "vitest";
import {
  createModelProvider,
  DemoModelProvider,
  enforceCapabilityAllowlist,
  namingOutputSchema,
} from "../src/index.js";

const namingInput = {
  generalized_intent: "reconcile_account_list",
  app_categories: ["crm", "spreadsheet"],
  object_type: "account",
  occurrence_count: 6,
  distinct_day_count: 3,
  median_duration_minutes: 11,
  redacted_steps: [{ order: 1, app: "Salesforce", action: "Look up records in" }],
  allowed_capability_ids: ["salesforce.query_records", "local.parse_csv"],
};

describe("DemoModelProvider", () => {
  const provider = new DemoModelProvider();

  it("supports the complete naming flow without any credential", async () => {
    const result = await provider.nameRecommendation(namingInput);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.title).toBe("Reconcile account lists with Salesforce");
      expect(namingOutputSchema.parse(result.value)).toBeTruthy();
      expect(result.usage.model_alias).toBe("demo");
    }
  });

  it("is deterministic", async () => {
    const a = await provider.nameRecommendation(namingInput);
    const b = await provider.nameRecommendation(namingInput);
    expect(a).toEqual(b);
  });

  it("drafts plans using only allowed capability ids", async () => {
    const result = await provider.draftAgentPlan({
      generalized_intent: "reconcile_account_list",
      desired_outcome: "Match rows by domain",
      canonical_steps: [],
      allowed_capability_ids: ["local.parse_csv", "salesforce.query_records"],
      budgets: { max_cost_usd: 1 },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const plan = result.value as { steps: Array<{ capability_id: string }> };
      for (const step of plan.steps) {
        expect(["local.parse_csv", "salesforce.query_records"]).toContain(step.capability_id);
      }
    }
  });
});

describe("capability allowlist enforcement (prompt-injection guard)", () => {
  it("rejects capability ids not offered in the prompt", () => {
    const check = enforceCapabilityAllowlist(
      ["salesforce.query_records", "shell.execute", "gmail.send"],
      ["salesforce.query_records"],
    );
    expect(check.ok).toBe(false);
    expect(check.offending).toEqual(["shell.execute", "gmail.send"]);
  });

  it("accepts a subset of allowed ids", () => {
    expect(enforceCapabilityAllowlist(["a"], ["a", "b"]).ok).toBe(true);
    expect(enforceCapabilityAllowlist([], ["a"]).ok).toBe(true);
  });
});

describe("factory", () => {
  it("falls back to demo without an API key", () => {
    expect(createModelProvider({ MODEL_PROVIDER: "anthropic" }).id).toBe("demo");
    expect(createModelProvider({}).id).toBe("demo");
  });

  it("uses anthropic when configured", () => {
    const provider = createModelProvider({
      MODEL_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "sk-ant-test",
    });
    expect(provider.id).toBe("anthropic");
  });

  it("naming output schema rejects oversized or missing fields", () => {
    expect(
      namingOutputSchema.safeParse({
        title: "x".repeat(100),
        summary: "valid summary here",
        generalized_intent: "ok_intent",
        capability_mapping: [],
      }).success,
    ).toBe(false);
    expect(namingOutputSchema.safeParse({ title: "Valid title" }).success).toBe(false);
  });
});
