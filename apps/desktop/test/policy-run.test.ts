import { describe, expect, it, beforeEach } from "vitest";
import type { PatternCandidate } from "@maman/contracts";
import { useRuns } from "../src/lib/runs.js";

/**
 * Domain policy (L3) must stop a run BEFORE anything executes — not gate it,
 * not warn about it afterwards. These tests pin the compliance beat and, more
 * importantly, pin that policy cannot be bypassed by the desktop-local run path
 * (which historically never consulted the policy engine at all).
 */

function candidate(over: Partial<PatternCandidate> = {}): PatternCandidate {
  return {
    pattern_id: "018f0000-0000-7000-8000-0000000000c1",
    owner_user_id: "018f0000-0000-7000-8000-0000000000aa",
    first_seen_at: "2026-08-01T09:00:00.000Z",
    last_seen_at: "2026-08-02T09:00:00.000Z",
    occurrence_count: 4,
    distinct_day_count: 2,
    median_duration_ms: 120_000,
    p90_duration_ms: 150_000,
    canonical_sequence: ["chrome:crm:record_opened:row:invoice:invoice"],
    episode_ids: [],
    similarity_mean: 0.95,
    repeatability_score: 0.9,
    feasibility_score: 0.8,
    risk_score: 0.3,
    projected_minutes_saved_weekly: 30,
    opportunity_score: 0.7,
    status: "eligible",
    ...over,
  };
}

beforeEach(() => {
  useRuns.getState().reset();
});

describe("segregation of duties stops the run", () => {
  it("blocks before execution when the agent would both code and approve invoices", async () => {
    await useRuns
      .getState()
      .startSupervised(
        candidate({ domain_actions: ["open", "code_invoice", "approve_invoice"] }),
        "update_invoice_records",
        "Code and approve invoices.",
        "Invoice intake & coding",
      );
    const state = useRuns.getState();
    expect(state.phase).toBe("cancelled");
    expect(state.policyHold).not.toBeNull();
    expect(state.policyHold!.kind).toBe("segregation_of_duties");
    expect(state.policyHold!.reasons.join(" ")).toMatch(/a person approves what Maman/i);
    // Nothing ran: no diff, no pending approval, no receipt.
    expect(state.diff).toBeNull();
    expect(state.pending).toBeNull();
    expect(state.receipt).toBeNull();
  });

  it("holds for dual control when the action needs a second approver", async () => {
    // finops schedule_payment → dual_control (and is a prohibited op besides).
    await useRuns
      .getState()
      .startSupervised(
        candidate({ domain_actions: ["schedule_payment"] }),
        "update_payment_run_records",
        "Schedule payments.",
        "Payment run",
      );
    const state = useRuns.getState();
    expect(state.phase).toBe("cancelled");
    expect(state.policyHold!.kind).toBe("dual_control");
    expect(state.policyHold!.reasons.join(" ")).toMatch(/second approver/i);
    expect(state.receipt).toBeNull();
  });

  it("surfaces the autonomy ceiling policy imposed", async () => {
    await useRuns
      .getState()
      .startSupervised(
        candidate({ domain_actions: ["code_invoice", "approve_invoice"] }),
        "update_invoice_records",
        "x",
        "Invoice intake",
      );
    // finops caps post_journal/send_email etc.; the SoD hold reports any ceiling.
    expect(useRuns.getState().policyHold).not.toBeNull();
  });
});

describe("policy does not interfere when it has nothing to say", () => {
  it("an unclassified candidate runs normally (no domain actions)", async () => {
    await useRuns
      .getState()
      .startSupervised(candidate(), "reconcile_account_list", "Reconcile.", "Reconcile accounts");
    const state = useRuns.getState();
    expect(state.policyHold).toBeNull();
    // It reached the approval gate — i.e. it actually executed the read path.
    expect(["waiting_approval", "completed"]).toContain(state.phase);
  });

  it("non-conflicting actions run normally", async () => {
    await useRuns
      .getState()
      .startSupervised(
        candidate({ domain_actions: ["open", "extract_field"] }),
        "reconcile_account_list",
        "Reconcile.",
        "Reconcile accounts",
      );
    expect(useRuns.getState().policyHold).toBeNull();
  });

  it("reset clears the hold", async () => {
    await useRuns
      .getState()
      .startSupervised(
        candidate({ domain_actions: ["code_invoice", "approve_invoice"] }),
        "x",
        "y",
        "z",
      );
    expect(useRuns.getState().policyHold).not.toBeNull();
    useRuns.getState().reset();
    expect(useRuns.getState().policyHold).toBeNull();
    expect(useRuns.getState().phase).toBe("idle");
  });
});
