import { describe, expect, it } from "vitest";
import type { PatternCandidate } from "@maman/contracts";
import { patternGates } from "../src/lib/forming.js";

/**
 * The "Forming" progress must mirror the real pattern-engine eligibility bars
 * exactly (no invented criteria) and speak plainly about what's still needed.
 */

function candidate(over: Partial<PatternCandidate> = {}): PatternCandidate {
  return {
    pattern_id: "018f0000-0000-7000-8000-000000000001",
    owner_user_id: "018f0000-0000-7000-8000-0000000000aa",
    first_seen_at: "2026-07-14T09:40:00.000Z",
    last_seen_at: "2026-07-16T15:00:00.000Z",
    occurrence_count: 6,
    distinct_day_count: 3,
    median_duration_ms: 660_000,
    p90_duration_ms: 780_000,
    canonical_sequence: [],
    episode_ids: [],
    similarity_mean: 0.9,
    repeatability_score: 0.9,
    feasibility_score: 0.8,
    risk_score: 0.3,
    projected_minutes_saved_weekly: 70,
    opportunity_score: 0.72,
    status: "candidate",
    ...over,
  };
}

describe("patternGates (forming progress)", () => {
  it("a fully-qualified pattern meets every check and reads as ready", () => {
    const p = patternGates(candidate());
    expect(p.metCount).toBe(p.total);
    expect(p.ratio).toBe(1);
    expect(p.nextStep).toMatch(/ready/i);
  });

  it("too-few repeats is the blocking check and the copy counts what's left", () => {
    const p = patternGates(candidate({ occurrence_count: 2, distinct_day_count: 1 }));
    expect(p.gates.find((g) => g.key === "repeats")!.met).toBe(false);
    expect(p.gates.find((g) => g.key === "repeats")!.detail).toBe("2 of 3 times");
    // Repeats is prioritized in the next-step sentence.
    expect(p.nextStep).toMatch(/1 more repeat/i);
    expect(p.metCount).toBeLessThan(p.total);
  });

  it("enough repeats but not enough distinct days asks for more days", () => {
    const p = patternGates(candidate({ occurrence_count: 5, distinct_day_count: 1 }));
    expect(p.gates.find((g) => g.key === "repeats")!.met).toBe(true);
    expect(p.gates.find((g) => g.key === "days")!.met).toBe(false);
    expect(p.nextStep).toMatch(/1 more day/i);
  });

  it("low consistency and low opportunity are surfaced as unmet checks", () => {
    const p = patternGates(candidate({ similarity_mean: 0.5, opportunity_score: 0.4 }));
    expect(p.gates.find((g) => g.key === "consistency")!.met).toBe(false);
    expect(p.gates.find((g) => g.key === "opportunity")!.met).toBe(false);
  });

  it("high risk fails the low-risk check", () => {
    const p = patternGates(candidate({ risk_score: 0.9 }));
    expect(p.gates.find((g) => g.key === "risk")!.met).toBe(false);
  });
});
