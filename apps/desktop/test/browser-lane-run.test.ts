import { beforeEach, describe, expect, it } from "vitest";
import type { PatternCandidate } from "@maman/contracts";
import { useRuns } from "../src/lib/runs.js";

/**
 * REGRESSION. Found by running the panel with no browser relay connected.
 *
 * Every step of the plan failed — nothing was written — and the run reported
 * "Finished a read-only run. Saved approximately 10 minutes", published a receipt
 * claiming ROI, and counted toward earned autonomy. Two things conspired: zero
 * writes made the receipt look like a read-only run, and `completed_with_warnings`
 * counts as a completed approved run.
 *
 * A run that applied nothing is a failure. Not a warning, not a read-only run, and
 * certainly not evidence that the agent can be trusted with more autonomy.
 */

function candidate(): PatternCandidate {
  return {
    pattern_id: "018f0000-0000-7000-8000-0000000000c2",
    owner_user_id: "018f0000-0000-7000-8000-0000000000aa",
    first_seen_at: "2026-08-01T09:00:00.000Z",
    last_seen_at: "2026-08-02T09:00:00.000Z",
    occurrence_count: 6,
    distinct_day_count: 3,
    median_duration_ms: 180_000,
    p90_duration_ms: 220_000,
    canonical_sequence: ["chrome:crm:record_opened:row:account:account"],
    episode_ids: [],
    similarity_mean: 0.95,
    repeatability_score: 0.9,
    feasibility_score: 0.8,
    risk_score: 0.3,
    projected_minutes_saved_weekly: 40,
    opportunity_score: 0.7,
    status: "eligible",
  };
}

const ORIGIN = "https://acme.my.salesforce.com";

beforeEach(() => {
  useRuns.getState().reset();
  useRuns.getState().setLane("api");
});

describe("a browser run that applied nothing", () => {
  it("fails, and does not claim savings, a receipt, or a completed run", async () => {
    useRuns.getState().setLane("browser", [ORIGIN]);
    await useRuns.getState().startSupervised(candidate());
    expect(useRuns.getState().phase).toBe("waiting_approval");
    // The plan is compiled before approval, so the user approves what they read.
    expect(useRuns.getState().browserPlan?.lines.length).toBeGreaterThan(0);

    // No Tauri and no relay in a test environment, so every dispatch throws — the
    // same conditions that produced the bug.
    await useRuns.getState().approve();

    const state = useRuns.getState();
    expect(state.phase).toBe("failed");
    expect(state.error).toBeTruthy();
    // Nothing to show, nothing to put back, nothing to be proud of.
    expect(state.receipt).toBeNull();
    expect(state.receiptSummary).toBeNull();
    expect(state.revertable).toEqual([]);
  });

  it("does not reach a phase that counts toward earned autonomy", async () => {
    useRuns.getState().setLane("browser", [ORIGIN]);
    await useRuns.getState().startSupervised(candidate());
    await useRuns.getState().approve();
    // Agents.tsx credits an approved run on completed / completed_with_warnings.
    expect(["completed", "completed_with_warnings"]).not.toContain(useRuns.getState().phase);
  });
});

describe("the browser lane is off until a site is named", () => {
  it("blocks the approval gate with the reason instead of offering a plan", async () => {
    useRuns.getState().setLane("browser", []);
    await useRuns.getState().startSupervised(candidate());
    expect(useRuns.getState().phase).toBe("waiting_approval");
    expect(useRuns.getState().browserPlan).toBeNull();
    expect(useRuns.getState().browserPlanRefusal).toContain("no allow-listed origin");
  });
});

describe("the api lane is unaffected", () => {
  it("still completes and still publishes a receipt", async () => {
    await useRuns.getState().startSupervised(candidate());
    expect(useRuns.getState().phase).toBe("waiting_approval");
    expect(useRuns.getState().browserPlan).toBeNull();
    await useRuns.getState().approve();
    expect(["completed", "completed_with_warnings"]).toContain(useRuns.getState().phase);
    expect(useRuns.getState().receipt).not.toBeNull();
  });

  it("records the lane the write actually used", async () => {
    await useRuns.getState().startSupervised(candidate());
    await useRuns.getState().approve();
    const receipt = useRuns.getState().receipt;
    expect(receipt).not.toBeNull();
    // The api lane genuinely used the api, so every step must say so. The browser
    // lane's own receipt source is NOT covered at runtime here: that path only
    // produces a receipt once something was applied, which needs a live relay.
    expect(new Set(receipt!.steps.map((s) => s.source))).toEqual(new Set(["api"]));
  });
});

describe("reset clears the browser lane's state", () => {
  it("leaves no stale plan or revert behind", async () => {
    useRuns.getState().setLane("browser", [ORIGIN]);
    await useRuns.getState().startSupervised(candidate());
    useRuns.getState().reset();
    const state = useRuns.getState();
    expect(state.browserPlan).toBeNull();
    expect(state.browserPlanRefusal).toBeNull();
    expect(state.revertable).toEqual([]);
    expect(state.phase).toBe("idle");
  });
});
