import { describe, expect, it } from "vitest";
import {
  aggregate,
  computeBaseline,
  computeNetValue,
  computeReceiptRoi,
  verifiedSavedMs,
} from "../src/index.js";

describe("baseline", () => {
  it("uses median active duration and caps at p90", () => {
    const baseline = computeBaseline({
      episode_durations_ms: [600_000, 660_000, 720_000, 3_000_000], // last is idle-inflated
      p90_ms: 780_000,
      similarity_mean: 0.9,
      user_confirmed: false,
    });
    // the 50-minute outlier is capped to p90 (13min) before median
    expect(baseline.median_manual_duration_ms).toBe(690_000);
    expect(baseline.occurrence_count).toBe(4);
  });

  it("confidence = min(1, count/10) * similarity_mean", () => {
    const b = computeBaseline({
      episode_durations_ms: Array(6).fill(600_000),
      p90_ms: 600_000,
      similarity_mean: 0.9,
      user_confirmed: false,
    });
    expect(b.confidence).toBeCloseTo(0.54, 5);
  });

  it("provenance: measured when user-confirmed, inferred at >=3, estimated below", () => {
    const base = { p90_ms: 600_000, similarity_mean: 0.9 };
    expect(
      computeBaseline({
        ...base,
        episode_durations_ms: Array(5).fill(600_000),
        user_confirmed: true,
      }).provenance,
    ).toBe("measured");
    expect(
      computeBaseline({
        ...base,
        episode_durations_ms: Array(5).fill(600_000),
        user_confirmed: false,
      }).provenance,
    ).toBe("inferred");
    expect(
      computeBaseline({ ...base, episode_durations_ms: [600_000], user_confirmed: false })
        .provenance,
    ).toBe("estimated");
  });
});

describe("verified saved time", () => {
  it("only verified runs count; disputed and projected contribute zero", () => {
    const input = { baseline_ms: 660_000, automated_human_ms: 60_000, intervention_ms: 30_000 };
    expect(verifiedSavedMs({ ...input, verification_status: "verified" })).toBe(570_000);
    expect(verifiedSavedMs({ ...input, verification_status: "disputed" })).toBe(0);
    expect(verifiedSavedMs({ ...input, verification_status: "projected" })).toBe(0);
  });

  it("never goes negative", () => {
    expect(
      verifiedSavedMs({
        baseline_ms: 60_000,
        automated_human_ms: 100_000,
        intervention_ms: 0,
        verification_status: "verified",
      }),
    ).toBe(0);
  });
});

describe("net value", () => {
  it("computes gross and net when a rate is configured", () => {
    const result = computeNetValue({
      verified_saved_ms: 3_600_000, // one hour
      loaded_hourly_rate_usd: 75,
      model_cost_usd: 0.01,
      connector_cost_usd: 0.07,
      infrastructure_cost_usd: 0.02,
    });
    expect(result.verified_net_hours).toBe(1);
    expect(result.gross_value_usd).toBe(75);
    expect(result.net_value_usd).toBe(74.9);
  });

  it("never infers a rate — value is null until configured", () => {
    const result = computeNetValue({
      verified_saved_ms: 3_600_000,
      loaded_hourly_rate_usd: null,
      model_cost_usd: 0.01,
      connector_cost_usd: 0,
      infrastructure_cost_usd: 0,
    });
    expect(result.gross_value_usd).toBeNull();
    expect(result.net_value_usd).toBeNull();
    expect(result.verified_net_hours).toBe(1);
  });
});

describe("receipt ROI provenance", () => {
  it("shadow runs never claim saved time", () => {
    const roi = computeReceiptRoi({
      manual_baseline_ms: 11 * 60_000,
      baseline_observation_count: 6,
      automated_human_ms: 60_000,
      human_review_ms: 60_000,
      mode: "shadow",
    });
    expect(roi.net_time_saved_ms).toBe(0);
    expect(roi.savings_provenance).toBe("estimated");
  });

  it("supervised runs with a measured baseline report measured savings", () => {
    const roi = computeReceiptRoi({
      manual_baseline_ms: 11 * 60_000,
      baseline_observation_count: 6,
      automated_human_ms: 60_000,
      human_review_ms: 60_000,
      mode: "supervised",
    });
    expect(roi.baseline_provenance).toBe("measured");
    expect(roi.savings_provenance).toBe("measured");
    expect(roi.net_time_saved_ms).toBe(11 * 60_000 - 120_000);
  });

  it("a thin baseline downgrades savings to estimated", () => {
    const roi = computeReceiptRoi({
      manual_baseline_ms: 11 * 60_000,
      baseline_observation_count: 1,
      automated_human_ms: 0,
      human_review_ms: 0,
      mode: "supervised",
    });
    expect(roi.baseline_provenance).toBe("estimated");
    expect(roi.savings_provenance).toBe("estimated");
  });
});

describe("aggregate reporting (cohort suppression)", () => {
  it("suppresses cohorts below five", () => {
    const result = aggregate({
      per_user_verified_hours: [1, 2, 3, 4],
      per_user_net_value_usd: [10, 20, 30, 40],
    });
    expect(result.suppressed).toBe(true);
    if (result.suppressed) expect(result.cohort_size).toBe(4);
  });

  it("reports sums at five or more, matching the sum of permitted users", () => {
    const result = aggregate({
      per_user_verified_hours: [1, 2, 3, 4, 5, 6],
      per_user_net_value_usd: [10, 20, 30, 40, 50, 60],
    });
    expect(result.suppressed).toBe(false);
    if (!result.suppressed) {
      expect(result.cohort_size).toBe(6);
      expect(result.total_verified_hours).toBe(21);
      expect(result.total_net_value_usd).toBe(210);
    }
  });
});
