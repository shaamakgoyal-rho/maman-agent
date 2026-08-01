import { describe, expect, it } from "vitest";
import { agentSpecSchema, uuidv7, type AgentSpec, type AgentStep } from "@maman/contracts";
import { describeAgentSpec } from "../src/describe.js";

/**
 * The agent description must state what the agent DOES, and may never overstate
 * its reach: a read-only agent must say so, and a writing agent must name both
 * the target and the approval gate. Every claim derives from a step's
 * capability + mode, so these assertions double as a guard on that mapping.
 */

function step(over: Partial<AgentStep> & Pick<AgentStep, "capability_id" | "mode">): AgentStep {
  return {
    step_id: over.step_id ?? `s-${over.order ?? 1}`,
    order: over.order ?? 1,
    name: over.name ?? "step",
    capability_id: over.capability_id,
    capability_version: 1,
    mode: over.mode,
    inputs: over.inputs ?? {},
    output_key: over.output_key ?? `out_${over.order ?? 1}`,
    risk_level: over.risk_level ?? "low",
    approval: over.approval ?? { required: over.mode === "write" },
    retry: over.retry ?? { allowed: true, max_attempts: 3, backoff_seconds: [1, 5, 30] },
  };
}

/** A schema-valid spec (parsed, not cast) so the fixture can't drift from the contract. */
function spec(steps: AgentStep[], inputs: AgentSpec["inputs"] = []): AgentSpec {
  return agentSpecSchema.parse({
    schema_version: 1,
    agent_id: uuidv7(),
    version_id: uuidv7(),
    organization_id: uuidv7(),
    owner_user_id: uuidv7(),
    source_pattern_id: uuidv7(),
    generalized_intent: "test_intent",
    name: "Test agent",
    description: "why it exists",
    state: "draft",
    trigger: { type: "manual" },
    inputs,
    steps,
    assertions: [],
    budgets: {
      max_runtime_seconds: 300,
      max_model_tokens: 12_000,
      max_cost_usd: 1,
      max_records_read: 1000,
      max_records_written: 20,
    },
    failure_policy: {
      on_assertion_failure: "stop",
      on_tool_failure: "retry_safe",
      max_safe_retries: 3,
      approval_timeout_minutes: 1440,
    },
    created_by: "compiler",
    created_at: "2026-08-01T12:00:00.000Z",
  });
}

describe("describeAgentSpec", () => {
  it("names the inputs, the sources it reads, and the approval-gated target", () => {
    const d = describeAgentSpec(
      spec(
        [
          step({ order: 1, capability_id: "local.parse_csv", mode: "read" }),
          step({ order: 2, capability_id: "salesforce.query_records", mode: "read" }),
          step({
            order: 3,
            capability_id: "salesforce.propose_field_updates",
            mode: "propose_write",
          }),
          step({
            order: 4,
            capability_id: "salesforce.update_fields",
            mode: "write",
            approval: { required: true, reason: "material CRM write" },
          }),
        ],
        [
          {
            key: "account_csv",
            label: "Account list (CSV)",
            type: "file_reference",
            required: true,
            sensitivity: "internal",
            source: "user",
          },
        ],
      ),
    );
    expect(d.read_only).toBe(false);
    expect(d.requires_approval).toBe(true);
    expect(d.reads).toEqual(["your own files", "Salesforce"]);
    expect(d.changes).toEqual(["Salesforce"]);
    expect(d.summary).toContain("You give it account list (csv)");
    expect(d.summary).toContain("reads your own files and Salesforce");
    expect(d.summary).toContain("shows you exactly what would change");
    expect(d.summary).toContain("only after you approve");
    expect(d.summary).toContain("at most 20 records");
    expect(d.limits).toBe("max 20 records, $1.00, 5 min per run");
    // Inline fragment: no trailing period, so it composes into a metadata line.
    expect(d.limits.endsWith(".")).toBe(false);
  });

  it("says plainly that a read-only agent changes nothing", () => {
    const d = describeAgentSpec(
      spec([
        step({ order: 1, capability_id: "salesforce.query_records", mode: "read" }),
        step({ order: 2, capability_id: "local.generate_csv", mode: "read" }),
      ]),
    );
    expect(d.read_only).toBe(true);
    expect(d.changes).toEqual([]);
    expect(d.requires_approval).toBe(false);
    expect(d.summary).toContain("never changes anything");
    // Must not imply a write or an approval it doesn't have.
    expect(d.summary).not.toMatch(/approve|updates/i);
  });

  it("never claims approval protection when a write is unapproved", () => {
    const d = describeAgentSpec(
      spec([
        step({
          order: 1,
          capability_id: "google_sheets.write_range",
          mode: "write",
          approval: { required: false },
        }),
      ]),
    );
    expect(d.requires_approval).toBe(false);
    expect(d.changes).toEqual(["Google Sheets"]);
    expect(d.summary).toContain("and then updates Google Sheets");
    expect(d.summary).not.toContain("after you approve");
  });

  it("is deterministic and ignores unknown capabilities rather than inventing a target", () => {
    const s = spec([step({ order: 1, capability_id: "not.a.real.capability", mode: "write" })]);
    const a = describeAgentSpec(s);
    const b = describeAgentSpec(s);
    expect(a).toEqual(b);
    expect(a.changes).toEqual([]);
    expect(a.read_only).toBe(true);
  });
});
