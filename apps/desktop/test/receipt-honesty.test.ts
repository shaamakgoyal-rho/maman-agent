import { beforeEach, describe, expect, it } from "vitest";
import type { PatternCandidate } from "@maman/contracts";
import { DEMO_ACCOUNT_LIST } from "@maman/agent-runtime";
import { useRuns } from "../src/lib/runs.js";

/**
 * A RECEIPT IS AN AUDIT RECORD, AND EVERY NUMBER IN IT WAS A LITERAL.
 *
 *   started_at: new Date(Date.now() - 2000)   // always "2 seconds ago"
 *   duration_ms: 100                          // every step, always
 *   totals.duration_ms: 2000
 *   totals.records_read: 10
 *   provider_cost_usd: mode === "shadow" ? 0 : 0.08
 *   roi: computeReceiptRoi({ manual_baseline_ms: 11 * 60_000,
 *                            baseline_observation_count: 6, ... })
 *
 * The last one is the worst. `MEASURED_BASELINE_MIN_OBSERVATIONS` is 3, so a
 * hardcoded count of 6 made `computeReceiptRoi` stamp the savings "measured",
 * and `petReceiptSummary` then said "Saved approximately 11 minutes" instead of
 * "Estimated (unconfirmed) savings". The provenance machinery was working
 * correctly the whole time — it was being fed invented inputs.
 */

/** A candidate whose duration and count are the ones the receipt must use. */
function candidate(over: Partial<PatternCandidate> = {}): PatternCandidate {
  return {
    pattern_id: "018f0000-0000-7000-8000-0000000000e1",
    owner_user_id: "018f0000-0000-7000-8000-0000000000aa",
    first_seen_at: "2026-08-01T09:00:00.000Z",
    last_seen_at: "2026-08-02T09:00:00.000Z",
    occurrence_count: 9,
    distinct_day_count: 4,
    // Deliberately NOT 11 minutes: if the receipt still reports 11, it is
    // reading the old literal rather than this pattern.
    median_duration_ms: 7 * 60_000,
    p90_duration_ms: 9 * 60_000,
    canonical_sequence: ["chrome:crm:record_opened:row:account:account"],
    episode_ids: [],
    similarity_mean: 0.95,
    repeatability_score: 0.9,
    feasibility_score: 0.8,
    risk_score: 0.3,
    projected_minutes_saved_weekly: 40,
    opportunity_score: 0.7,
    status: "eligible",
    ...over,
  };
}

const INTENT = "reconcile_account_list";
const OUTCOME = "Reconcile the account list with Salesforce.";

beforeEach(() => {
  useRuns.getState().reset();
  useRuns.getState().setLane("api");
});

describe("timings come from the run, not from a literal", () => {
  it("reports a real elapsed window rather than a fixed 2 seconds", async () => {
    const before = Date.now();
    await useRuns.getState().startShadow(candidate(), INTENT, OUTCOME, "helper");
    const after = Date.now();

    const receipt = useRuns.getState().receipt;
    if (!receipt) throw new Error(`no receipt; phase=${useRuns.getState().phase}`);

    const startedAt = Date.parse(receipt.started_at);
    const completedAt = Date.parse(receipt.completed_at);
    // The window has to sit inside the wall-clock window of the actual call.
    expect(startedAt).toBeGreaterThanOrEqual(before);
    expect(completedAt).toBeLessThanOrEqual(after);
    expect(receipt.totals.duration_ms).toBe(completedAt - startedAt);
    // The old code produced exactly 2000 every time, from a subtraction.
    expect(completedAt - startedAt).not.toBe(2000);
  });

  it("gives each step its own measured duration, not 100ms each", async () => {
    await useRuns.getState().startShadow(candidate(), INTENT, OUTCOME, "helper");
    const receipt = useRuns.getState().receipt!;

    // NOT asserted: that a step took more than 0ms. The demo adapters finish in
    // well under a millisecond, so 0 is the honest rounded answer and demanding
    // otherwise would only be satisfiable by inventing a number again.
    //
    // What IS asserted: no step carries the old constant, and the step
    // durations cannot exceed the window that contains them — an invariant the
    // old code broke silently (4 steps × 100ms inside a fabricated 2000ms).
    expect(receipt.steps.every((s) => s.duration_ms !== 100)).toBe(true);
    const summed = receipt.steps.reduce((n, s) => n + s.duration_ms, 0);
    expect(summed).toBeLessThanOrEqual(receipt.totals.duration_ms);
  });

  it("keeps totals consistent with the steps they summarise", async () => {
    // `records_read: 10` in totals could never be reconciled with the per-step
    // zeros beneath it. The total is now the sum, so the two cannot disagree.
    await useRuns.getState().startShadow(candidate(), INTENT, OUTCOME, "helper");
    const receipt = useRuns.getState().receipt!;
    const summed = receipt.steps.reduce((n, s) => n + s.records_read, 0);
    expect(receipt.totals.records_read).toBe(summed);
    expect(receipt.totals.records_read).not.toBe(10);
  });

  it("counts records it actually read", async () => {
    // The bundled sample list has rows, and the parse step returns them, so
    // this is a real count rather than an assumption that reads read nothing.
    await useRuns.getState().startShadow(candidate(), INTENT, OUTCOME, "helper");
    const receipt = useRuns.getState().receipt!;
    expect(receipt.totals.records_read).toBeGreaterThan(0);
  });
});

describe("the ROI baseline is observed, not chosen", () => {
  it("uses the pattern's own median duration and occurrence count", async () => {
    await useRuns.getState().startShadow(candidate(), INTENT, OUTCOME, "helper");
    const roi = useRuns.getState().receipt!.roi;
    expect(roi.manual_baseline_ms).toBe(7 * 60_000);
    expect(roi.baseline_observation_count).toBe(9);
    // The literals that used to be here.
    expect(roi.manual_baseline_ms).not.toBe(11 * 60_000);
    expect(roi.baseline_observation_count).not.toBe(6);
  });

  it("DEGRADES to estimated when the pattern has too few observations", async () => {
    // This is the case the old hardcoded 6 made unreachable: a pattern seen
    // twice cannot support a measured savings claim, and the receipt now says
    // so instead of borrowing confidence from a literal.
    await useRuns
      .getState()
      .startShadow(candidate({ occurrence_count: 2 }), INTENT, OUTCOME, "helper");
    const roi = useRuns.getState().receipt!.roi;
    expect(roi.baseline_observation_count).toBe(2);
    expect(roi.baseline_provenance).toBe("estimated");
  });

  it("still marks a well-observed pattern as measured", async () => {
    await useRuns
      .getState()
      .startShadow(candidate({ occurrence_count: 12 }), INTENT, OUTCOME, "helper");
    expect(useRuns.getState().receipt!.roi.baseline_provenance).toBe("measured");
  });
});

describe("cost is not invented", () => {
  it("reports zero for a runtime that bills nothing", async () => {
    // The local runtime makes no provider call. `0.08` looked plausible and was
    // pure fiction, and it survived into ROI as a real subtraction.
    await useRuns.getState().startShadow(candidate(), INTENT, OUTCOME, "helper");
    const totals = useRuns.getState().receipt!.totals;
    expect(totals.provider_cost_usd).toBe(0);
    expect(totals.total_cost_usd).toBe(0);
  });
});

describe("measurements do not leak between runs", () => {
  it("starts each run's clock fresh", async () => {
    await useRuns.getState().startShadow(candidate(), INTENT, OUTCOME, "helper");
    const first = useRuns.getState().receipt!;
    useRuns.getState().reset();

    await useRuns.getState().startShadow(candidate(), INTENT, OUTCOME, "helper");
    const second = useRuns.getState().receipt!;

    expect(Date.parse(second.started_at)).toBeGreaterThanOrEqual(Date.parse(first.completed_at));
    expect(second.run_id).not.toBe(first.run_id);
  });

  it("does not inherit the previous pattern's baseline", async () => {
    await useRuns
      .getState()
      .startShadow(candidate({ occurrence_count: 12 }), INTENT, OUTCOME, "helper");
    expect(useRuns.getState().receipt!.roi.baseline_provenance).toBe("measured");
    useRuns.getState().reset();

    await useRuns
      .getState()
      .startShadow(candidate({ occurrence_count: 2 }), INTENT, OUTCOME, "helper");
    expect(useRuns.getState().receipt!.roi.baseline_provenance).toBe("estimated");
  });
});

/** Referenced so the sample-list sentinel stays exercised by this suite too. */
export const SAMPLE = DEMO_ACCOUNT_LIST;
