import { describe, expect, it } from "vitest";
import { uuidv7, type AgentSpec, type AgentStep } from "@maman/contracts";
import {
  approvalRequirement,
  classifyStepRisk,
  DEFAULT_ORG_POLICY,
  evaluateSpec,
  evaluateStep,
  orgPolicySchema,
  type EvaluationContext,
  type OrgPolicy,
} from "../src/index.js";

const ctx: EvaluationContext = {
  policy_version_id: uuidv7(),
  evaluated_at: "2026-07-17T18:00:00.000Z",
};

function mkStep(overrides: Partial<AgentStep> = {}): AgentStep {
  return {
    step_id: "s1",
    order: 1,
    name: "step",
    capability_id: "salesforce.query_records",
    capability_version: 1,
    mode: "read",
    inputs: {},
    output_key: "out",
    risk_level: "low",
    approval: { required: false },
    retry: { allowed: true, max_attempts: 3, backoff_seconds: [1, 5, 30] },
    ...overrides,
  };
}

function mkSpec(steps: AgentStep[], overrides: Partial<AgentSpec> = {}): AgentSpec {
  return {
    schema_version: 1,
    agent_id: uuidv7(),
    version_id: uuidv7(),
    organization_id: uuidv7(),
    owner_user_id: uuidv7(),
    name: "Test",
    description: "d",
    generalized_intent: "test",
    source_pattern_id: uuidv7(),
    state: "draft",
    trigger: { type: "manual" },
    inputs: [],
    steps,
    assertions: [],
    budgets: {
      max_runtime_seconds: 300,
      max_model_tokens: 10_000,
      max_cost_usd: 1,
      max_records_read: 1000,
      max_records_written: 20,
    },
    failure_policy: {
      on_assertion_failure: "stop",
      on_tool_failure: "stop",
      max_safe_retries: 1,
      approval_timeout_minutes: 1440,
    },
    created_at: "2026-07-17T18:00:00.000Z",
    created_by: "compiler",
  } satisfies AgentSpec as AgentSpec;
  // overrides applied below for exactOptionalPropertyTypes friendliness
}

function spec(steps: AgentStep[], overrides: Partial<AgentSpec> = {}): AgentSpec {
  return { ...mkSpec(steps), ...overrides };
}

describe("risk classification — every level (spec §14)", () => {
  it("reads are low risk", () => {
    expect(classifyStepRisk({ capability_id: "salesforce.query_records", mode: "read" })).toBe(
      "low",
    );
    expect(classifyStepRisk({ capability_id: "local.parse_csv", mode: "read" })).toBe("low");
    expect(classifyStepRisk({ capability_id: "browser.extract_table", mode: "read" })).toBe("low");
  });

  it("proposed diffs are low risk", () => {
    expect(
      classifyStepRisk({
        capability_id: "salesforce.propose_field_updates",
        mode: "propose_write",
      }),
    ).toBe("low");
  });

  it("draft creation and small CRM writes are medium", () => {
    expect(classifyStepRisk({ capability_id: "gmail.create_draft", mode: "write" })).toBe("medium");
    expect(
      classifyStepRisk({ capability_id: "google_calendar.create_event_draft", mode: "write" }),
    ).toBe("medium");
    expect(classifyStepRisk({ capability_id: "google_sheets.write_range", mode: "write" })).toBe(
      "medium",
    );
    expect(
      classifyStepRisk({
        capability_id: "salesforce.update_fields",
        mode: "write",
        max_records_written: 20,
      }),
    ).toBe("medium");
  });

  it("record-count boundary: 20 stays medium, 21 escalates to high", () => {
    const at20 = classifyStepRisk({
      capability_id: "salesforce.update_fields",
      mode: "write",
      max_records_written: 20,
    });
    const at21 = classifyStepRisk({
      capability_id: "salesforce.update_fields",
      mode: "write",
      max_records_written: 21,
    });
    expect(at20).toBe("medium");
    expect(at21).toBe("high");
  });

  it("record-count boundary: 500 is high, 501 is prohibited", () => {
    expect(
      classifyStepRisk({
        capability_id: "salesforce.update_fields",
        mode: "write",
        max_records_written: 500,
      }),
    ).toBe("high");
    expect(
      classifyStepRisk({
        capability_id: "salesforce.update_fields",
        mode: "write",
        max_records_written: 501,
      }),
    ).toBe("prohibited");
  });

  it("sensitive CRM fields escalate to high", () => {
    for (const field of ["stagename", "ownerid", "amount", "forecastcategory", "consent"]) {
      expect(
        classifyStepRisk({
          capability_id: "salesforce.update_fields",
          mode: "write",
          max_records_written: 1,
          updated_fields: [field],
        }),
      ).toBe("high");
    }
  });

  it("UI-only writes with no API verification are high", () => {
    expect(
      classifyStepRisk({
        capability_id: "browser.supervised_form_fill",
        mode: "write",
        ui_only_write: true,
      }),
    ).toBe("high");
  });

  it("customer-facing content is high", () => {
    expect(
      classifyStepRisk({
        capability_id: "google_sheets.write_range",
        mode: "write",
        max_records_written: 1,
        customer_facing: true,
      }),
    ).toBe("high");
  });

  it("unknown capabilities are prohibited", () => {
    expect(classifyStepRisk({ capability_id: "shell.execute", mode: "read" })).toBe("prohibited");
    expect(classifyStepRisk({ capability_id: "gmail.send", mode: "write" })).toBe("prohibited");
  });

  it("prohibited verbs are prohibited regardless of catalog", () => {
    expect(classifyStepRisk({ capability_id: "salesforce.delete_records", mode: "write" })).toBe(
      "prohibited",
    );
  });
});

describe("approval requirements (spec §14)", () => {
  const noUnattended = { capability_id: "gmail.create_draft", unattended_medium_capabilities: [] };

  it("low reads need no approval", () => {
    expect(approvalRequirement("low", "read", noUnattended)).toBe("none");
  });

  it("propose_write never needs approval (nothing changes)", () => {
    expect(approvalRequirement("low", "propose_write", noUnattended)).toBe("none");
    expect(approvalRequirement("medium", "propose_write", noUnattended)).toBe("none");
  });

  it("medium writes need one approval per run by default", () => {
    expect(approvalRequirement("medium", "write", noUnattended)).toBe("per_run");
  });

  it("org may allow an explicitly named medium capability unattended", () => {
    expect(
      approvalRequirement("medium", "write", {
        capability_id: "gmail.create_draft",
        unattended_medium_capabilities: ["gmail.create_draft"],
      }),
    ).toBe("none");
  });

  it("high risk always requires run-specific approval — never unattended", () => {
    expect(
      approvalRequirement("high", "write", {
        capability_id: "salesforce.update_fields",
        unattended_medium_capabilities: ["salesforce.update_fields"], // even if listed!
      }),
    ).toBe("always");
  });

  it("prohibited is denied", () => {
    expect(approvalRequirement("prohibited", "write", noUnattended)).toBe("denied");
  });
});

describe("step evaluation against org policy", () => {
  it("allows a permitted read", () => {
    const decision = evaluateStep(spec([mkStep()]), mkStep(), DEFAULT_ORG_POLICY, ctx);
    expect(decision.decision).toBe("allow");
    expect(decision.policy_version_id).toBe(ctx.policy_version_id);
  });

  it("denies a disabled capability", () => {
    const policy: OrgPolicy = {
      ...DEFAULT_ORG_POLICY,
      disabled_capabilities: ["salesforce.query_records"],
    };
    const decision = evaluateStep(spec([mkStep()]), mkStep(), policy, ctx);
    expect(decision.decision).toBe("deny");
    expect(decision.reasons[0]!.code).toBe("capability_disabled");
  });

  it("denies a disabled connector", () => {
    const policy: OrgPolicy = {
      ...DEFAULT_ORG_POLICY,
      enabled_connectors: ["local"],
    };
    const decision = evaluateStep(spec([mkStep()]), mkStep(), policy, ctx);
    expect(decision.decision).toBe("deny");
  });

  it("denies a capability version mismatch", () => {
    const policy: OrgPolicy = {
      ...DEFAULT_ORG_POLICY,
      allowed_capabilities: [{ id: "salesforce.query_records", version: 2 }],
    };
    const decision = evaluateStep(spec([mkStep()]), mkStep(), policy, ctx);
    expect(decision.decision).toBe("deny");
  });

  it("denies unknown capabilities (prohibited tool)", () => {
    const step = mkStep({ capability_id: "arbitrary.tool" });
    const decision = evaluateStep(spec([step]), step, DEFAULT_ORG_POLICY, ctx);
    expect(decision.decision).toBe("deny");
    expect(decision.reasons.map((r) => r.code)).toContain("unknown_capability");
  });

  it("requires approval for a medium write", () => {
    const step = mkStep({
      capability_id: "salesforce.update_fields",
      mode: "write",
      risk_level: "medium",
      approval: { required: true },
    });
    const decision = evaluateStep(spec([step]), step, DEFAULT_ORG_POLICY, ctx);
    expect(decision.decision).toBe("require_approval");
  });
});

describe("spec evaluation", () => {
  it("allows a read-only spec outright", () => {
    const decision = evaluateSpec(spec([mkStep()]), DEFAULT_ORG_POLICY, ctx);
    expect(decision.decision).toBe("allow");
  });

  it("requires approval when any write step exists", () => {
    const writeStep = mkStep({
      step_id: "s2",
      order: 2,
      capability_id: "salesforce.update_fields",
      mode: "write",
      risk_level: "medium",
      approval: { required: true },
    });
    const decision = evaluateSpec(spec([mkStep(), writeStep]), DEFAULT_ORG_POLICY, ctx);
    expect(decision.decision).toBe("require_approval");
  });

  it("denies a high-risk step missing approval declaration", () => {
    const badStep = mkStep({
      capability_id: "salesforce.update_fields",
      mode: "write",
      risk_level: "high",
      approval: { required: false },
    });
    const s = spec([badStep], {
      budgets: {
        max_runtime_seconds: 300,
        max_model_tokens: 10_000,
        max_cost_usd: 1,
        max_records_read: 1000,
        max_records_written: 30, // >20 CRM → high
      },
    });
    const decision = evaluateSpec(s, DEFAULT_ORG_POLICY, ctx);
    expect(decision.decision).toBe("deny");
    expect(decision.reasons.map((r) => r.code)).toContain("high_risk_missing_approval");
  });

  it("denies write budgets above the organization cap", () => {
    const policy: OrgPolicy = { ...DEFAULT_ORG_POLICY, max_records_written: 10 };
    const decision = evaluateSpec(spec([mkStep()]), policy, ctx);
    expect(decision.decision).toBe("deny");
    expect(decision.reasons.map((r) => r.code)).toContain("write_budget_exceeded");
  });

  it("cost boundary: exactly at the cap passes, above is denied", () => {
    const policy: OrgPolicy = { ...DEFAULT_ORG_POLICY, max_run_cost_usd: 1 };
    expect(evaluateSpec(spec([mkStep()]), policy, ctx).decision).toBe("allow");
    const over = spec([mkStep()], {
      budgets: {
        max_runtime_seconds: 300,
        max_model_tokens: 10_000,
        max_cost_usd: 1.01,
        max_records_read: 1000,
        max_records_written: 20,
      },
    });
    expect(evaluateSpec(over, policy, ctx).decision).toBe("deny");
  });

  it("read budget above cap is denied", () => {
    const policy: OrgPolicy = { ...DEFAULT_ORG_POLICY, max_records_read: 100 };
    const decision = evaluateSpec(spec([mkStep()]), policy, ctx);
    expect(decision.decision).toBe("deny");
    expect(decision.reasons.map((r) => r.code)).toContain("read_budget_exceeded");
  });

  it("schedule boundary: schedules denied unless org allows them", () => {
    const scheduled = spec([mkStep()], {
      trigger: { type: "schedule", cron: "0 * * * *", timezone: "UTC" },
    });
    expect(evaluateSpec(scheduled, DEFAULT_ORG_POLICY, ctx).decision).toBe("deny");
    const policy: OrgPolicy = { ...DEFAULT_ORG_POLICY, allow_scheduled_supervised: true };
    expect(evaluateSpec(scheduled, policy, ctx).decision).toBe("allow");
  });

  it("every decision carries the policy version and reasons", () => {
    const decision = evaluateSpec(spec([mkStep()]), DEFAULT_ORG_POLICY, ctx);
    expect(decision.policy_version_id).toBe(ctx.policy_version_id);
    expect(decision.evaluated_at).toBe(ctx.evaluated_at);
    expect(decision.reasons.length).toBeGreaterThan(0);
    expect(decision.reasons[0]).toHaveProperty("rule_id");
  });
});

describe("org policy schema", () => {
  it("cohort minimum can never go below five", () => {
    expect(orgPolicySchema.safeParse({ ...DEFAULT_ORG_POLICY, min_cohort_size: 4 }).success).toBe(
      false,
    );
    expect(orgPolicySchema.safeParse({ ...DEFAULT_ORG_POLICY, min_cohort_size: 5 }).success).toBe(
      true,
    );
  });

  it("write cap can never exceed 500", () => {
    expect(
      orgPolicySchema.safeParse({ ...DEFAULT_ORG_POLICY, max_records_written: 501 }).success,
    ).toBe(false);
  });

  it("rejects unknown fields", () => {
    expect(
      orgPolicySchema.safeParse({ ...DEFAULT_ORG_POLICY, allow_everything: true }).success,
    ).toBe(false);
  });
});
