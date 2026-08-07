import { describe, expect, it } from "vitest";
import { uuidv7, type PatternCandidate } from "@maman/contracts";
import { DEFAULT_ORG_POLICY } from "@maman/policy-engine";
import { compileAgentSpec, type CompileRequest } from "../src/compiler.js";
import { validateAgentSpec } from "../src/validator.js";

/**
 * THE REGRESSION THIS FILE EXISTS FOR.
 *
 * On the first real device, every eligible card was a live-observed BROWSER
 * workflow — and clicking "Try it" failed on all of them with
 * "I couldn't safely draft this helper yet" (C-NO-PLAN). The only recipe
 * matched CRM reconciliation intents; the deterministic namer derives
 * `automate_<object>_workflow` for an anonymous page, which matched nothing,
 * and the constrained model draft has nothing to contribute for a sequence
 * with no object nouns. So detection worked, verification worked, and the
 * product still could not produce a single agent.
 *
 * These tests pin the browser recipe AND its refusals — the point is not
 * "always compile something", it is "compile the safe supervised shape when
 * the observed work really is browser-only, and refuse honestly otherwise".
 */

/** The live device's eligible pattern 019fc4d0 (replay 21/21), verbatim. */
const LIVE_SEQUENCE = [
  "macos_ax:browser:element_focused:AXGroup:-:-",
  "macos_ax:browser:value_committed:AXStaticText:-:-",
  "macos_ax:browser:value_committed:AXTextField:-:-",
];

function candidate(sequence: string[]): PatternCandidate {
  return {
    pattern_id: uuidv7(),
    owner_user_id: uuidv7(),
    first_seen_at: "2026-08-02T23:29:58.543Z",
    last_seen_at: "2026-08-05T18:08:55.617Z",
    occurrence_count: 24,
    distinct_day_count: 4,
    median_duration_ms: 30_000,
    p90_duration_ms: 45_000,
    canonical_sequence: sequence,
    episode_ids: [],
    similarity_mean: 1,
    repeatability_score: 0.9,
    feasibility_score: 1,
    risk_score: 0.38,
    projected_minutes_saved_weekly: 12,
    opportunity_score: 0.69,
    status: "eligible",
  };
}

function request(sequence: string[], intent = "automate_record_workflow"): CompileRequest {
  return {
    candidate: candidate(sequence),
    generalized_intent: intent,
    desired_outcome: "Fill the fields I fill on this page.",
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
    now: () => new Date("2026-08-07T06:00:00.000Z"),
  };
}

describe("the live browser workflow compiles to a real agent", () => {
  it("compiles the device's own eligible pattern instead of refusing", async () => {
    const result = await compileAgentSpec(request(LIVE_SEQUENCE));
    // The exact failure observed on device was status "blocked" / C-NO-PLAN.
    expect(result.status).toBe("valid");
  });

  it("compiles the canonical supervised shape: read, propose, approved write, verify", async () => {
    const result = await compileAgentSpec(request(LIVE_SEQUENCE));
    if (result.status !== "valid") throw new Error(`expected valid, got ${result.status}`);
    expect(result.spec.steps.map((s) => [s.capability_id, s.mode])).toEqual([
      ["browser.extract_structured_fields", "read"],
      ["browser.propose_form_fill", "propose_write"],
      ["browser.supervised_form_fill", "write"],
      // The independent re-read: the run's own verification, not a claim.
      ["browser.extract_structured_fields", "read"],
    ]);
  });

  it("gates the one write on explicit approval, always", async () => {
    const result = await compileAgentSpec(request(LIVE_SEQUENCE));
    if (result.status !== "valid") throw new Error("expected valid");
    const writes = result.spec.steps.filter((s) => s.mode === "write");
    expect(writes).toHaveLength(1);
    expect(writes[0]!.approval.required).toBe(true);
    expect(result.policy_decision.decision).toBe("require_approval");
  });

  it("passes the static validator it will be re-checked by", async () => {
    const result = await compileAgentSpec(request(LIVE_SEQUENCE));
    if (result.status !== "valid") throw new Error("expected valid");
    const validation = validateAgentSpec(result.spec);
    // Name the rules on failure — a bare `false` says nothing about which
    // invariant the recipe broke.
    expect(
      validation.valid,
      validation.valid ? "" : validation.issues.map((i) => i.rule).join(", "),
    ).toBe(true);
  });

  it("compiles a READ-ONLY helper when nothing observed was a real edit", async () => {
    // Only page-updates-itself steps: the role-aware mapping makes these
    // reads, so the helper must change nothing rather than invent a write.
    const result = await compileAgentSpec(
      request([
        "macos_ax:browser:element_focused:AXGroup:-:-",
        "macos_ax:browser:value_committed:AXStaticText:-:-",
      ]),
    );
    if (result.status !== "valid") throw new Error("expected valid");
    expect(result.spec.steps.every((s) => s.mode === "read")).toBe(true);
    expect(result.spec.steps).toHaveLength(1);
  });

  it("REFUSES a flow that is not browser-only, rather than ignoring half the work", async () => {
    // Spreadsheet work mixed in: this shape cannot honour it, so blocking is
    // the correct answer — a helper that silently skipped it would be worse.
    const result = await compileAgentSpec(
      request([
        "macos_ax:browser:value_committed:AXTextField:-:-",
        "chrome:spreadsheet:table_read:grid:account_list:account",
      ]),
    );
    expect(result.status).toBe("needs_configuration");
  });

  it("REFUSES when the observed steps map to no capability at all", async () => {
    // An unidentifiable native app: feasibility would be 0 and there is
    // nothing to compile. Never fabricate a plan for it.
    const result = await compileAgentSpec(
      request(["macos_ax:other:value_committed:AXTextField:-:-"]),
    );
    expect(result.status).toBe("needs_configuration");
  });

  it("leaves CRM reconciliation intents on their own recipe", async () => {
    // The browser recipe must not hijack an intent the CRM recipe owns.
    const result = await compileAgentSpec(
      request(LIVE_SEQUENCE, "reconcile_account_list") as CompileRequest,
    );
    if (result.status !== "valid") throw new Error("expected valid");
    expect(result.spec.steps.some((s) => s.capability_id.startsWith("salesforce."))).toBe(true);
  });
});
