import { describe, expect, it } from "vitest";
import { agentSpecSchema, uuidv7, type AgentSpec } from "../src/index.js";

export function validSpec(): AgentSpec {
  return {
    schema_version: 1,
    agent_id: uuidv7(),
    version_id: uuidv7(),
    organization_id: uuidv7(),
    owner_user_id: uuidv7(),
    name: "Reconcile account lists with Salesforce",
    description: "Matches CSV rows to Salesforce accounts and proposes field updates.",
    generalized_intent: "reconcile_account_list",
    source_pattern_id: uuidv7(),
    state: "draft",
    trigger: { type: "manual" },
    inputs: [
      {
        key: "account_csv",
        label: "Account CSV",
        type: "file_reference",
        required: true,
        sensitivity: "internal",
        source: "user",
      },
    ],
    steps: [
      {
        step_id: "parse-csv",
        order: 1,
        name: "Parse account CSV",
        capability_id: "local.parse_csv",
        capability_version: 1,
        mode: "read",
        inputs: { file: { source: "agent_input", ref: "account_csv" } },
        output_key: "rows",
        risk_level: "low",
        approval: { required: false },
        retry: { allowed: true, max_attempts: 3, backoff_seconds: [1, 5, 30] },
      },
    ],
    assertions: [
      {
        assertion_id: "row-count",
        type: "record_count_between",
        config: { output_key: "rows", min: 1, max: 1000 },
        severity: "blocking",
      },
    ],
    budgets: {
      max_runtime_seconds: 300,
      max_model_tokens: 12000,
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
  };
}

describe("agentSpecSchema", () => {
  it("accepts a valid draft spec", () => {
    expect(agentSpecSchema.parse(validSpec())).toBeTruthy();
  });

  it("rejects unknown top-level fields", () => {
    const spec = { ...validSpec(), shell_command: "rm -rf /" };
    expect(agentSpecSchema.safeParse(spec).success).toBe(false);
  });

  it("rejects unknown fields inside a step", () => {
    const spec = validSpec();
    const bad = {
      ...spec,
      steps: [{ ...spec.steps[0]!, javascript: "alert(1)" }],
    };
    expect(agentSpecSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a secret-shaped literal in step inputs", () => {
    const spec = validSpec();
    const bad = {
      ...spec,
      steps: [
        {
          ...spec.steps[0]!,
          inputs: {
            file: { source: "literal", value: "api_key=sk_live_abcdefghijklmnop123456" },
          },
        },
      ],
    };
    expect(agentSpecSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a private-key literal", () => {
    const spec = validSpec();
    const bad = {
      ...spec,
      steps: [
        {
          ...spec.steps[0]!,
          inputs: {
            file: {
              source: "literal",
              value: "-----BEGIN RSA PRIVATE KEY-----\nMIIE...",
            },
          },
        },
      ],
    };
    expect(agentSpecSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an unknown assertion type", () => {
    const spec = validSpec();
    const bad = {
      ...spec,
      assertions: [
        {
          assertion_id: "x",
          type: "run_sql",
          config: { sql: "DROP TABLE users" },
          severity: "blocking",
        },
      ],
    };
    expect(agentSpecSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects assertion config with unknown fields", () => {
    const spec = validSpec();
    const bad = {
      ...spec,
      assertions: [
        {
          assertion_id: "row-count",
          type: "record_count_between",
          config: { output_key: "rows", min: 1, max: 10, script: "x()" },
          severity: "blocking",
        },
      ],
    };
    expect(agentSpecSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an unknown trigger type", () => {
    const spec = { ...validSpec(), trigger: { type: "webhook", url: "http://evil.example" } };
    expect(agentSpecSchema.safeParse(spec).success).toBe(false);
  });

  it("rejects an invalid state", () => {
    const spec = { ...validSpec(), state: "autonomous" };
    expect(agentSpecSchema.safeParse(spec).success).toBe(false);
  });

  it("rejects retry attempts above the cap", () => {
    const spec = validSpec();
    const bad = {
      ...spec,
      steps: [
        {
          ...spec.steps[0]!,
          retry: { allowed: true, max_attempts: 99, backoff_seconds: [1] },
        },
      ],
    };
    expect(agentSpecSchema.safeParse(bad).success).toBe(false);
  });

  it("accepts a schedule trigger with cron and timezone", () => {
    const spec: AgentSpec = {
      ...validSpec(),
      trigger: { type: "schedule", cron: "0 9 * * 1-5", timezone: "America/Los_Angeles" },
    };
    expect(agentSpecSchema.parse(spec)).toBeTruthy();
  });
});
