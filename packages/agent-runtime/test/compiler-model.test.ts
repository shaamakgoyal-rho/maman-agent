import { describe, expect, it } from "vitest";
import { uuidv7, type PatternCandidate } from "@maman/contracts";
import { DEFAULT_ORG_POLICY } from "@maman/policy-engine";
import type {
  CompileInput,
  ModelProvider,
  ModelResult,
  NamingInput,
  NamingOutput,
} from "@maman/model-provider";
import { compileAgentSpec, type CompileRequest } from "../src/compiler.js";

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
    canonical_sequence: [],
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
    desired_outcome: "Reconcile account lists with Salesforce.",
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

/** A configurable model stand-in for testing the compiler's model handling. */
class MockModel implements ModelProvider {
  readonly id = "anthropic" as const;
  constructor(
    private readonly opts: {
      naming?: ModelResult<NamingOutput>;
      draft?: ModelResult<unknown>;
    },
  ) {}
  async nameRecommendation(_input: NamingInput): Promise<ModelResult<NamingOutput>> {
    return (
      this.opts.naming ?? {
        ok: false as const,
        error: "unavailable" as const,
      }
    );
  }
  async draftAgentPlan(_input: CompileInput): Promise<ModelResult<unknown>> {
    return this.opts.draft ?? { ok: false, error: "unavailable" };
  }
}

const usage = (input: number, output: number, alias = "claude-sonnet-5") => ({
  input_tokens: input,
  output_tokens: output,
  model_alias: alias,
});

describe("compiler — model provider wiring (M14)", () => {
  it("applies model naming as COPY over the recipe, and surfaces model cost", async () => {
    const model = new MockModel({
      naming: {
        ok: true,
        value: {
          title: "Keep Salesforce accounts in sync",
          summary: "A friendlier summary written by the model for the recommendation card.",
          generalized_intent: "reconcile_account_list",
          capability_mapping: [],
        },
        usage: usage(1000, 500),
      },
    });
    const result = await compileAgentSpec(request({ model }));
    expect(result.status).toBe("valid");
    if (result.status !== "valid") return;
    // Copy came from the model; the deterministic recipe still built the steps.
    expect(result.spec.name).toBe("Keep Salesforce accounts in sync");
    expect(result.compiled_by).toBe("recipe");
    expect(result.model_usage?.model_alias).toBe("claude-sonnet-5");
    // 1000/1e6*3 + 500/1e6*15 = 0.003 + 0.0075 = 0.0105
    expect(result.model_cost_usd).toBeCloseTo(0.0105, 6);
  });

  it("keeps the deterministic title when naming would exceed the compile budget", async () => {
    const model = new MockModel({
      naming: {
        ok: true,
        value: {
          title: "Should not be used — over budget",
          summary: "This naming call is priced above the per-compile budget and must be dropped.",
          generalized_intent: "reconcile_account_list",
          capability_mapping: [],
        },
        // 1M in + 1M out on sonnet = $18, far above max_cost_usd = $0.50 below.
        usage: usage(1_000_000, 1_000_000),
      },
    });
    const result = await compileAgentSpec(
      request({ model, budgets: { ...request().budgets, max_cost_usd: 0.5 } }),
    );
    expect(result.status).toBe("valid");
    if (result.status !== "valid") return;
    expect(result.spec.name).toBe("Reconcile account lists with Salesforce"); // deterministic
    expect(result.model_usage).toBeNull();
    expect(result.model_cost_usd).toBe(0);
  });

  it("rejects a model draft that references a capability not in the catalog", async () => {
    const model = new MockModel({
      draft: {
        ok: true,
        value: { steps: [{ capability_id: "evil.delete_all_records" }] },
        usage: usage(100, 100),
      },
    });
    // A non-recipe intent forces the model-draft path.
    const result = await compileAgentSpec(
      request({ model, generalized_intent: "unknown_custom_intent" }),
    );
    expect(result.status).toBe("blocked");
  });

  it("falls back to blocked when the model draft would exceed the compile budget", async () => {
    const model = new MockModel({
      draft: {
        ok: true,
        value: { steps: [{ capability_id: "salesforce.query_records" }] },
        usage: usage(1_000_000, 1_000_000), // $18 on sonnet
      },
    });
    const result = await compileAgentSpec(
      request({
        model,
        generalized_intent: "unknown_custom_intent",
        budgets: { ...request().budgets, max_cost_usd: 0.1 },
      }),
    );
    expect(result.status).toBe("blocked");
  });

  it("no model provided → deterministic recipe with zero model cost", async () => {
    const result = await compileAgentSpec(request());
    expect(result.status).toBe("valid");
    if (result.status !== "valid") return;
    expect(result.model_usage).toBeNull();
    expect(result.model_cost_usd).toBe(0);
    expect(result.spec.name).toBe("Reconcile account lists with Salesforce");
  });
});
