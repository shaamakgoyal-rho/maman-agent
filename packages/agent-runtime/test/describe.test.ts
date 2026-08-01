import { describe, expect, it } from "vitest";
import { agentSpecSchema, uuidv7, type AgentSpec, type AgentStep } from "@maman/contracts";
import { describeAgentSpec, describeProposedHelper } from "../src/describe.js";
import { compileAgentSpec, type CompileRequest } from "../src/compiler.js";
import { DEFAULT_ORG_POLICY } from "@maman/policy-engine";

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

/** A real compile request for the reconciliation recipe. */
function request(): CompileRequest {
  return {
    candidate: {
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
    },
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
  };
}

describe("describeProposedHelper (suggestion card, nothing compiled yet)", () => {
  it("speaks conditionally and names the read sources and the approval-gated target", () => {
    const d = describeProposedHelper([
      "local.parse_csv",
      "salesforce.query_records",
      "salesforce.propose_field_updates",
      "salesforce.update_fields",
    ]);
    expect(d.read_only).toBe(false);
    expect(d.reads).toEqual(["your own files", "Salesforce"]);
    expect(d.changes).toEqual(["Salesforce"]);
    expect(d.summary).toBe(
      "It would read your own files and Salesforce, show you every change first, then — only with your approval — update Salesforce.",
    );
    // A proposal must not claim limits it hasn't compiled yet.
    expect(d.summary).not.toMatch(/\$|records|minutes/);
  });

  it("says a read-only helper would change nothing", () => {
    const d = describeProposedHelper(["salesforce.query_records", "google_sheets.read_range"]);
    expect(d.read_only).toBe(true);
    expect(d.changes).toEqual([]);
    expect(d.summary).toBe(
      "It would read Salesforce and Google Sheets, and change nothing at all.",
    );
    expect(d.summary).not.toMatch(/approv|update/i);
  });

  it("ignores unknown capabilities and stays empty rather than inventing a claim", () => {
    expect(describeProposedHelper([])).toEqual({
      summary: "",
      reads: [],
      changes: [],
      read_only: true,
    });
    expect(describeProposedHelper(["not.real"]).summary).toBe("");
  });

  it("writes_need_approval_is_guaranteed: the compiler never emits an unapproved write", async () => {
    // The card's "only with your approval" wording is only honest because every
    // compiled write step demands approval. Assert that on the real recipe
    // rather than trusting the copy.
    const result = await compileAgentSpec(request());
    expect(result.status).toBe("valid");
    if (result.status !== "valid") return;
    const writes = result.spec.steps.filter((s) => s.mode === "write");
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) expect(w.approval.required).toBe(true);
  });
});
