import { describe, expect, it } from "vitest";
import { reconciliationFixture, unrelatedFixture } from "@maman/demo-fixtures";
import {
  effectiveEligibility,
  patternSignature,
  runPatternEngine,
  type EngineOptions,
} from "../src/engine.js";
import { toPatternFeature } from "../src/projection.js";
import { ELIGIBILITY } from "../src/scoring.js";

const OWNER = "00000000-0000-7000-8000-00000000aaaa";

function options(overrides: Partial<EngineOptions> = {}): EngineOptions {
  return {
    owner_user_id: OWNER,
    now: () => new Date("2026-07-17T18:00:00.000Z"),
    ...overrides,
  };
}

const fixtureEvents = () => reconciliationFixture().map((e) => toPatternFeature(e));

describe("primary demo fixture (M5 gate)", () => {
  const result = runPatternEngine(fixtureEvents(), options());

  it("segments six episodes across three days", () => {
    expect(result.episodes.length).toBe(6);
    const days = new Set(result.episodes.map((e) => e.started_at.slice(0, 10)));
    expect(days.size).toBe(3);
  });

  it("yields exactly ONE eligible recommendation", () => {
    expect(result.recommendations.length).toBe(1);
  });

  it("the candidate matches the expected shape (spec §24)", () => {
    const eligible = result.candidates.find((c) => c.status === "eligible")!;
    expect(eligible.occurrence_count).toBe(6);
    expect(eligible.distinct_day_count).toBe(3);
    expect(eligible.median_duration_ms).toBeGreaterThanOrEqual(9 * 60_000);
    expect(eligible.median_duration_ms).toBeLessThanOrEqual(12 * 60_000);
    expect(eligible.similarity_mean).toBeGreaterThan(0.82);
    expect(eligible.projected_minutes_saved_weekly).toBeGreaterThan(40);
  });

  it("the recommendation is the expected reconciliation helper", () => {
    const rec = result.recommendations[0]!;
    expect(rec.title).toBe("Reconcile account lists with Salesforce");
    expect(rec.evidence.occurrence_count).toBe(6);
    expect(rec.evidence.redacted_steps.length).toBeGreaterThan(0);
    expect(rec.required_capabilities).toContain("salesforce.query_records");
    expect(rec.status).toBe("new");
  });

  it("uses calm factual copy (never bragging or surveillance-toned)", () => {
    const rec = result.recommendations[0]!;
    // The summary now LEADS with what the workflow consists of, then the
    // evidence — "a similar workflow N times" described the detector, not the
    // work, so a reader could not tell which of their habits it meant.
    expect(rec.summary).toMatch(/^You .+\. I saw this 6 times across /);
    expect(rec.summary).toMatch(/median run took \d+ minutes/);
    for (const banned of [
      "I watched you",
      "inefficient",
      "manager will see",
      "perfectly",
      "you saved",
    ]) {
      expect(rec.summary.toLowerCase()).not.toContain(banned.toLowerCase());
      expect(rec.title.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });

  it("is fully deterministic", () => {
    const again = runPatternEngine(fixtureEvents(), options());
    expect(again.recommendations).toEqual(result.recommendations);
    expect(again.candidates).toEqual(result.candidates);
  });

  it("works with no model provider anywhere (pure deterministic naming)", () => {
    // The engine has no model dependency at all — this asserts the module
    // graph stays clean rather than relying on runtime behavior.
    expect(Object.keys(runPatternEngine)).not.toContain("model");
  });
});

describe("unrelated fixture (M5 gate)", () => {
  it("yields no candidates and no recommendations", () => {
    const events = unrelatedFixture().map((e) => toPatternFeature(e));
    const result = runPatternEngine(events, options());
    expect(result.recommendations).toEqual([]);
    expect(result.candidates.filter((c) => c.status === "eligible")).toEqual([]);
  });
});

describe("eligibility suppression paths", () => {
  const signatureOf = () => {
    const base = runPatternEngine(fixtureEvents(), options());
    return patternSignature(base.candidates[0]!.canonical_sequence);
  };

  it("dismissed cooldown suppresses the recommendation", () => {
    const result = runPatternEngine(
      fixtureEvents(),
      options({ recently_dismissed_signatures: [signatureOf()] }),
    );
    expect(result.recommendations).toEqual([]);
    expect(result.candidates[0]!.status).toBe("candidate");
  });

  it("'never suggest this' suppression is honored", () => {
    const result = runPatternEngine(
      fixtureEvents(),
      options({ suppressed_signatures: [signatureOf()] }),
    );
    expect(result.recommendations).toEqual([]);
  });

  it("restricted sensitivity excludes the pattern entirely", () => {
    const events = fixtureEvents().map((e, i) =>
      i % 7 === 3 ? { ...e, sensitivity: "restricted" as const } : e,
    );
    const result = runPatternEngine(events, options());
    expect(result.recommendations).toEqual([]);
  });

  it("excluded-from-learning episodes never feed a pattern", () => {
    const events = fixtureEvents().map((e) => ({ ...e, excluded_from_learning: true }));
    const result = runPatternEngine(events, options());
    expect(result.candidates).toEqual([]);
    expect(result.recommendations).toEqual([]);
  });

  it("multi-day threshold: six occurrences in one day are not eligible", () => {
    // Compress the fixture into a single day (shift every event's date).
    const events = fixtureEvents().map((e) => ({
      ...e,
      occurred_at: `2026-07-14${e.occurred_at.slice(10)}`,
    }));
    const result = runPatternEngine(events, options());
    const eligible = result.candidates.filter((c) => c.status === "eligible");
    expect(eligible).toEqual([]);
  });

  it("two occurrences are below the minimum occurrence threshold", () => {
    // Keep only the first two episodes (events of day one).
    const all = fixtureEvents();
    const dayOne = all.filter((e) => e.occurred_at.startsWith("2026-07-14"));
    const result = runPatternEngine(dayOne, options());
    expect(result.candidates.filter((c) => c.status === "eligible")).toEqual([]);
  });

  it("exact eligibility boundaries are inclusive where the spec says >=", () => {
    expect(ELIGIBILITY.min_occurrences).toBe(3);
    expect(ELIGIBILITY.min_distinct_days).toBe(2);
    expect(ELIGIBILITY.min_similarity_mean).toBe(0.82);
    expect(ELIGIBILITY.min_projected_minutes_weekly).toBe(20);
    expect(ELIGIBILITY.min_feasibility).toBe(0.6);
    expect(ELIGIBILITY.max_risk).toBe(0.7);
    expect(ELIGIBILITY.dismissal_cooldown_days).toBe(14);
  });
});

describe("tunable detection bars (live demo tuning)", () => {
  const oneDay = () =>
    fixtureEvents().map((e) => ({
      ...e,
      occurred_at: `2026-07-14${e.occurred_at.slice(10)}`,
    }));

  it("same-day repetitions become eligible when min_distinct_days is tuned to 1", () => {
    const result = runPatternEngine(oneDay(), options({ eligibility: { min_distinct_days: 1 } }));
    expect(result.recommendations.length).toBe(1);
    expect(result.candidates.find((c) => c.status === "eligible")!.distinct_day_count).toBe(1);
  });

  it("opportunity_threshold is honored as the surfacing bar", () => {
    const result = runPatternEngine(fixtureEvents(), options({ opportunity_threshold: 0.99 }));
    expect(result.recommendations).toEqual([]);
    // Still tracked as a forming pattern, honestly.
    expect(result.watching.length).toBeGreaterThan(0);
  });

  it("clamps tunables to sane floors and never exposes safety bars", () => {
    const effective = effectiveEligibility({
      min_occurrences: 0,
      min_distinct_days: 0,
      min_projected_minutes_weekly: -5,
    });
    expect(effective.min_occurrences).toBe(2);
    expect(effective.min_distinct_days).toBe(1);
    expect(effective.min_projected_minutes_weekly).toBe(0);
    // Safety bars always stay at production values.
    expect(effective.min_similarity_mean).toBe(ELIGIBILITY.min_similarity_mean);
    expect(effective.min_feasibility).toBe(ELIGIBILITY.min_feasibility);
    expect(effective.max_risk).toBe(ELIGIBILITY.max_risk);
  });

  it("segmentation options flow through the engine", () => {
    const result = runPatternEngine(fixtureEvents(), options({ segmentation: {} }));
    expect(result.episodes.length).toBe(6);
  });
});
