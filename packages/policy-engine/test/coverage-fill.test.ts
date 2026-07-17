import { describe, expect, it } from "vitest";
import { uuidv7, type AgentStep, type AgentSpec } from "@maman/contracts";
import {
  classifyStepRisk,
  DEFAULT_ORG_POLICY,
  evaluateStep,
  type EvaluationContext,
} from "../src/index.js";

const ctx: EvaluationContext = {
  policy_version_id: uuidv7(),
  evaluated_at: "2026-07-17T18:00:00.000Z",
};

describe("risk edge branches", () => {
  it("prohibited verbs are caught even before catalog lookup", () => {
    expect(classifyStepRisk({ capability_id: "gmail.send", mode: "read" })).toBe("prohibited");
    expect(classifyStepRisk({ capability_id: "salesforce.delete_records", mode: "write" })).toBe(
      "prohibited",
    );
    expect(classifyStepRisk({ capability_id: "billing.payment_run", mode: "write" })).toBe(
      "prohibited",
    );
  });

  it("prohibited catalog risk stays prohibited on reads", () => {
    // No catalog capability is prohibited today; unknown ids exercise the path.
    expect(classifyStepRisk({ capability_id: "unknown.thing", mode: "read" })).toBe("prohibited");
  });

  it("propose_write without records stays at catalog level", () => {
    expect(
      classifyStepRisk({
        capability_id: "salesforce.propose_field_updates",
        mode: "propose_write",
      }),
    ).toBe("low");
  });

  it("escalation never de-escalates high back to medium", () => {
    expect(
      classifyStepRisk({
        capability_id: "browser.supervised_form_fill", // catalog high
        mode: "write",
        max_records_written: 1,
      }),
    ).toBe("high");
  });
});

describe("evaluateSpec step-denial aggregation", () => {
  it("spec evaluation prefixes denied step reasons with the step id", async () => {
    const { evaluateSpec } = await import("../src/index.js");
    const step: AgentStep = {
      step_id: "bad-step",
      order: 1,
      name: "q",
      capability_id: "salesforce.query_records",
      capability_version: 1,
      mode: "read",
      inputs: {},
      output_key: "o",
      risk_level: "low",
      approval: { required: false },
      retry: { allowed: true, max_attempts: 3, backoff_seconds: [1] },
    };
    const spec = {
      schema_version: 1,
      agent_id: uuidv7(),
      version_id: uuidv7(),
      organization_id: uuidv7(),
      owner_user_id: uuidv7(),
      name: "t",
      description: "d",
      generalized_intent: "t",
      source_pattern_id: uuidv7(),
      state: "draft",
      trigger: { type: "manual" },
      inputs: [],
      steps: [step],
      assertions: [],
      budgets: {
        max_runtime_seconds: 300,
        max_model_tokens: 1,
        max_cost_usd: 1,
        max_records_read: 10,
        max_records_written: 1,
      },
      failure_policy: {
        on_assertion_failure: "stop",
        on_tool_failure: "stop",
        max_safe_retries: 0,
        approval_timeout_minutes: 60,
      },
      created_at: "2026-07-17T18:00:00.000Z",
      created_by: "compiler",
    } as const satisfies AgentSpec;
    const decision = evaluateSpec(
      spec,
      { ...DEFAULT_ORG_POLICY, disabled_capabilities: ["salesforce.query_records"] },
      ctx,
    );
    expect(decision.decision).toBe("deny");
    expect(decision.reasons[0]!.message).toContain("step bad-step:");
  });
});

describe("evaluateStep allowlist branch", () => {
  it("explicit allowlist admits exactly the listed id+version", () => {
    const step: AgentStep = {
      step_id: "s1",
      order: 1,
      name: "q",
      capability_id: "salesforce.query_records",
      capability_version: 1,
      mode: "read",
      inputs: {},
      output_key: "o",
      risk_level: "low",
      approval: { required: false },
      retry: { allowed: true, max_attempts: 3, backoff_seconds: [1] },
    };
    const spec = {
      schema_version: 1,
      agent_id: uuidv7(),
      version_id: uuidv7(),
      organization_id: uuidv7(),
      owner_user_id: uuidv7(),
      name: "t",
      description: "d",
      generalized_intent: "t",
      source_pattern_id: uuidv7(),
      state: "draft",
      trigger: { type: "manual" },
      inputs: [],
      steps: [step],
      assertions: [],
      budgets: {
        max_runtime_seconds: 300,
        max_model_tokens: 1,
        max_cost_usd: 1,
        max_records_read: 10,
        max_records_written: 1,
      },
      failure_policy: {
        on_assertion_failure: "stop",
        on_tool_failure: "stop",
        max_safe_retries: 0,
        approval_timeout_minutes: 60,
      },
      created_at: "2026-07-17T18:00:00.000Z",
      created_by: "compiler",
    } as const satisfies AgentSpec;

    const allowed = evaluateStep(
      spec,
      step,
      {
        ...DEFAULT_ORG_POLICY,
        allowed_capabilities: [{ id: "salesforce.query_records", version: 1 }],
      },
      ctx,
    );
    expect(allowed.decision).toBe("allow");

    const denied = evaluateStep(
      spec,
      step,
      { ...DEFAULT_ORG_POLICY, allowed_capabilities: [{ id: "local.parse_csv", version: 1 }] },
      ctx,
    );
    expect(denied.decision).toBe("deny");
  });
});
