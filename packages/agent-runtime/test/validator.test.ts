import { describe, expect, it } from "vitest";
import { uuidv7, type AgentSpec, type AgentStep } from "@maman/contracts";
import { minCronIntervalMinutes, validateAgentSpec } from "../src/validator.js";

function mkStep(overrides: Partial<AgentStep> = {}): AgentStep {
  return {
    step_id: `s${overrides.order ?? 1}`,
    order: 1,
    name: "step",
    capability_id: "local.parse_csv",
    capability_version: 1,
    mode: "read",
    inputs: {},
    output_key: `out${overrides.order ?? 1}`,
    risk_level: "low",
    approval: { required: false },
    retry: { allowed: true, max_attempts: 3, backoff_seconds: [1, 5, 30] },
    ...overrides,
  };
}

function mkSpec(overrides: Partial<AgentSpec> = {}): AgentSpec {
  return {
    schema_version: 1,
    agent_id: uuidv7(),
    version_id: uuidv7(),
    organization_id: uuidv7(),
    owner_user_id: uuidv7(),
    name: "Test agent",
    description: "d",
    generalized_intent: "test",
    source_pattern_id: uuidv7(),
    state: "draft",
    trigger: { type: "manual" },
    inputs: [],
    steps: [mkStep()],
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
    ...overrides,
  };
}

function rulesOf(result: ReturnType<typeof validateAgentSpec>): string[] {
  return result.valid ? [] : result.issues.map((i) => i.rule);
}

describe("static AgentSpec validation (spec §13 — every rejection condition)", () => {
  it("accepts a minimal valid spec", () => {
    expect(validateAgentSpec(mkSpec()).valid).toBe(true);
  });

  it("rejects unknown fields (schema is strict)", () => {
    const result = validateAgentSpec({ ...mkSpec(), shell: "rm -rf /" });
    expect(rulesOf(result)).toContain("V-SCHEMA");
  });

  it("rejects non-object garbage", () => {
    expect(validateAgentSpec("not a spec").valid).toBe(false);
    expect(validateAgentSpec(null).valid).toBe(false);
  });

  it("rejects more than twenty steps", () => {
    const steps = Array.from({ length: 21 }, (_, i) =>
      mkStep({ order: i + 1, step_id: `s${i + 1}`, output_key: `o${i + 1}` }),
    );
    expect(rulesOf(validateAgentSpec(mkSpec({ steps })))).toContain("V-STEPS-1");
  });

  it("rejects duplicate step order", () => {
    const steps = [mkStep({ order: 1 }), mkStep({ order: 1, step_id: "s1b", output_key: "o2" })];
    expect(rulesOf(validateAgentSpec(mkSpec({ steps })))).toContain("V-STEPS-2");
  });

  it("rejects noncontiguous step order", () => {
    const steps = [mkStep({ order: 1 }), mkStep({ order: 3, step_id: "s3", output_key: "o3" })];
    expect(rulesOf(validateAgentSpec(mkSpec({ steps })))).toContain("V-STEPS-2");
  });

  it("rejects duplicate step ids", () => {
    const steps = [
      mkStep({ order: 1, step_id: "same" }),
      mkStep({ order: 2, step_id: "same", output_key: "o2" }),
    ];
    expect(rulesOf(validateAgentSpec(mkSpec({ steps })))).toContain("V-STEPS-3");
  });

  it("rejects a missing referenced agent input", () => {
    const steps = [mkStep({ inputs: { file: { source: "agent_input", ref: "missing" } } })];
    expect(rulesOf(validateAgentSpec(mkSpec({ steps })))).toContain("V-REF-1");
  });

  it("rejects a missing referenced step output", () => {
    const steps = [mkStep({ inputs: { data: { source: "step_output", ref: "ghost" } } })];
    expect(rulesOf(validateAgentSpec(mkSpec({ steps })))).toContain("V-REF-2");
  });

  it("rejects circular step-output dependencies", () => {
    const steps = [
      mkStep({ order: 1, inputs: { data: { source: "step_output", ref: "out2" } } }),
      mkStep({ order: 2, step_id: "s2", output_key: "out2" }),
    ];
    expect(rulesOf(validateAgentSpec(mkSpec({ steps })))).toContain("V-REF-3");
  });

  it("rejects self-referencing steps", () => {
    const steps = [mkStep({ inputs: { data: { source: "step_output", ref: "out1" } } })];
    expect(rulesOf(validateAgentSpec(mkSpec({ steps })))).toContain("V-REF-3");
  });

  it("rejects absent capabilities", () => {
    const steps = [mkStep({ capability_id: "not.a.capability" })];
    expect(rulesOf(validateAgentSpec(mkSpec({ steps })))).toContain("V-CAP-1");
  });

  it("rejects unavailable capability versions", () => {
    const steps = [mkStep({ capability_version: 99 })];
    expect(rulesOf(validateAgentSpec(mkSpec({ steps })))).toContain("V-CAP-2");
  });

  it("rejects step modes the capability does not support", () => {
    const steps = [mkStep({ capability_id: "local.parse_csv", mode: "write" })];
    expect(rulesOf(validateAgentSpec(mkSpec({ steps })))).toContain("V-CAP-3");
  });

  it("rejects prohibited risk", () => {
    const steps = [mkStep({ risk_level: "prohibited" })];
    expect(rulesOf(validateAgentSpec(mkSpec({ steps })))).toContain("V-RISK-1");
  });

  it("rejects high-risk steps without approval", () => {
    const steps = [
      mkStep({
        capability_id: "salesforce.update_fields",
        mode: "write",
        risk_level: "high",
        approval: { required: false },
      }),
    ];
    expect(rulesOf(validateAgentSpec(mkSpec({ steps })))).toContain("V-RISK-2");
  });

  it("rejects runtime above thirty minutes (boundary)", () => {
    const at = mkSpec({
      budgets: { ...mkSpec().budgets, max_runtime_seconds: 1800 },
    });
    expect(validateAgentSpec(at).valid).toBe(true);
    const over = mkSpec({
      budgets: { ...mkSpec().budgets, max_runtime_seconds: 1801 },
    });
    expect(rulesOf(validateAgentSpec(over))).toContain("V-BUDGET-1");
  });

  it("rejects write budgets above 500 (boundary)", () => {
    const at = mkSpec({ budgets: { ...mkSpec().budgets, max_records_written: 500 } });
    expect(validateAgentSpec(at).valid).toBe(true);
    const over = mkSpec({ budgets: { ...mkSpec().budgets, max_records_written: 501 } });
    expect(rulesOf(validateAgentSpec(over))).toContain("V-BUDGET-2");
  });

  it("rejects secret-shaped literals (schema layer catches it first; validator is defense in depth)", () => {
    const steps = [
      mkStep({
        inputs: {
          key: { source: "literal", value: "api_key=sk_live_ABCDEFGHIJKLMNOPQR12345" },
        },
      }),
    ];
    const rules = rulesOf(validateAgentSpec(mkSpec({ steps })));
    expect(rules.some((r) => r === "V-SCHEMA" || r === "V-SECRET-1")).toBe(true);
  });

  it("rejects URL literals (arbitrary URLs are prohibited)", () => {
    const steps = [
      mkStep({ inputs: { target: { source: "literal", value: "https://evil.example/x" } } }),
    ];
    expect(rulesOf(validateAgentSpec(mkSpec({ steps })))).toContain("V-URL-1");
  });

  it("rejects SQL/shell/script-shaped literals (arbitrary execution)", () => {
    for (const value of [
      "DROP TABLE users",
      "SELECT * FROM accounts",
      "x; rm -rf /",
      "<script>1</script>",
    ]) {
      const steps = [mkStep({ inputs: { q: { source: "literal", value } } })];
      expect(rulesOf(validateAgentSpec(mkSpec({ steps }))), value).toContain("V-EXEC-1");
    }
  });

  it("rejects schedules more frequent than fifteen minutes (boundary)", () => {
    const every10 = mkSpec({
      trigger: { type: "schedule", cron: "*/10 * * * *", timezone: "UTC" },
    });
    expect(rulesOf(validateAgentSpec(every10))).toContain("V-SCHED-1");
    const every15 = mkSpec({
      trigger: { type: "schedule", cron: "*/15 * * * *", timezone: "UTC" },
    });
    expect(validateAgentSpec(every15).valid).toBe(true);
  });

  it("rejects unparseable cron", () => {
    const bad = mkSpec({ trigger: { type: "schedule", cron: "whenever", timezone: "UTC" } });
    expect(rulesOf(validateAgentSpec(bad))).toContain("V-SCHED-2");
  });

  it("rejects unknown trigger shapes at the schema layer", () => {
    const result = validateAgentSpec({
      ...mkSpec(),
      trigger: { type: "webhook", url: "https://x.example" },
    });
    expect(rulesOf(result)).toContain("V-SCHEMA");
  });

  it("collects MULTIPLE issues in one pass", () => {
    const steps = [
      mkStep({ order: 1, capability_id: "nope.nope" }),
      mkStep({ order: 3, step_id: "s3", output_key: "o3" }),
    ];
    const result = validateAgentSpec(mkSpec({ steps }));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.issues.length).toBeGreaterThanOrEqual(2);
  });
});

describe("cron interval estimation", () => {
  it("computes step and fixed-minute intervals", () => {
    expect(minCronIntervalMinutes("*/5 * * * *")).toBe(5);
    expect(minCronIntervalMinutes("*/30 * * * *")).toBe(30);
    expect(minCronIntervalMinutes("0 9 * * 1-5")).toBe(60);
    expect(minCronIntervalMinutes("* * * * *")).toBe(1);
    expect(minCronIntervalMinutes("0,20,40 * * * *")).toBe(20);
    expect(minCronIntervalMinutes("not cron")).toBeNull();
    expect(minCronIntervalMinutes("0 0 * *")).toBeNull();
  });
});
