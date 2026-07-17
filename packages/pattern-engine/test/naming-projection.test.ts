import { describe, expect, it } from "vitest";
import type { PatternCandidate, WorkflowEvent } from "@maman/contracts";
import { uuidv7 } from "@maman/contracts";
import { deterministicName } from "../src/naming.js";
import { categorizeApp, toPatternFeature } from "../src/projection.js";
import { representativeSequence } from "../src/scoring.js";
import type { SegmentedEpisode } from "../src/segmentation.js";

function candidate(
  sequence: string[],
  overrides: Partial<PatternCandidate> = {},
): PatternCandidate {
  return {
    pattern_id: uuidv7(),
    owner_user_id: uuidv7(),
    first_seen_at: "2026-07-14T10:00:00.000Z",
    last_seen_at: "2026-07-16T10:00:00.000Z",
    occurrence_count: 4,
    distinct_day_count: 2,
    median_duration_ms: 300_000,
    p90_duration_ms: 400_000,
    canonical_sequence: sequence,
    episode_ids: [],
    similarity_mean: 0.9,
    repeatability_score: 0.9,
    feasibility_score: 0.8,
    risk_score: 0.2,
    projected_minutes_saved_weekly: 30,
    opportunity_score: 0.7,
    status: "eligible",
    ...overrides,
  };
}

function episodeWith(categories: string[]): SegmentedEpisode {
  return {
    episode_id: uuidv7(),
    started_at: "2026-07-14T10:00:00.000Z",
    ended_at: "2026-07-14T10:10:00.000Z",
    active_duration_ms: 600_000,
    events: [],
    canonical_tokens: [],
    app_categories: categories,
    sensitivity_max: "internal",
    excluded_from_learning: false,
  };
}

describe("deterministic naming branches", () => {
  it("crm update recipe", () => {
    const naming = deterministicName(
      candidate([
        "chrome:crm:record_opened:row:account:opportunity",
        "chrome:crm:record_updated:field:x:opportunity",
      ]),
      [episodeWith(["crm"])],
    );
    expect(naming.title).toBe("Update Salesforce opportunity records from your workflow");
  });

  it("spreadsheet report recipe", () => {
    const naming = deterministicName(
      candidate([
        "chrome:spreadsheet:table_read:grid:x:pipeline",
        "chrome:spreadsheet:table_exported:grid:x:pipeline",
      ]),
      [episodeWith(["spreadsheet"])],
    );
    expect(naming.title).toBe("Build your recurring pipeline report");
  });

  it("generic fallback across arbitrary categories", () => {
    const naming = deterministicName(
      candidate([
        "chrome:email:navigation:-:inbox:thread",
        "chrome:calendar:element_activated:-:event:thread",
      ]),
      [episodeWith(["email", "calendar"])],
    );
    expect(naming.title).toMatch(/^Automate your thread workflow across /);
  });

  it("falls back to 'record' when no object types exist", () => {
    const naming = deterministicName(
      candidate(["chrome:email:navigation:-:-:-", "chrome:email:record_opened:-:-:-"]),
      [episodeWith(["email"])],
    );
    expect(naming.title).toContain("record");
  });
});

describe("projection branches", () => {
  const base: WorkflowEvent = {
    schema_version: 1,
    event_id: uuidv7(),
    device_id: uuidv7(),
    user_id: uuidv7(),
    organization_id: uuidv7(),
    occurred_at: "2026-07-14T10:00:00.000Z",
    monotonic_ms: 1,
    source: "chrome",
    app: { display_name: "Salesforce", domain: "x.lightning.force.com" },
    event_type: "table_read",
    target: {},
    context: {},
    sensitivity: "internal",
    redaction: { applied: false, reasons: [] },
  };

  it("buckets item counts into the five locked buckets", () => {
    const bucketFor = (n: number) =>
      toPatternFeature({ ...base, context: { item_count: n } }).item_count_bucket;
    expect(bucketFor(1)).toBe("1");
    expect(bucketFor(5)).toBe("2_10");
    expect(bucketFor(30)).toBe("11_50");
    expect(bucketFor(100)).toBe("51_200");
    expect(bucketFor(500)).toBe("201_plus");
    expect(toPatternFeature(base).item_count_bucket).toBeUndefined();
  });

  it("categorizes all app families", () => {
    expect(categorizeApp("Salesforce", "x.force.com")).toBe("crm");
    expect(categorizeApp("Google Sheets", "docs.google.com")).toBe("spreadsheet");
    expect(categorizeApp("Gmail", "mail.google.com")).toBe("email");
    expect(categorizeApp("Calendar", "calendar.google.com")).toBe("calendar");
    expect(categorizeApp("LinkedIn", "linkedin.com")).toBe("research");
    expect(categorizeApp("Something", "example.com")).toBe("browser");
    expect(categorizeApp("TextEdit")).toBe("other");
  });

  it("projection never carries domains, hashes, or labels", () => {
    const feature = toPatternFeature(base);
    const json = JSON.stringify(feature);
    expect(json).not.toContain("force.com");
    expect(json).not.toMatch(/label|hash|bundle/);
  });
});

describe("representative sequence", () => {
  it("picks the episode closest to the median length", () => {
    const mk = (n: number): SegmentedEpisode => ({
      ...episodeWith(["crm"]),
      canonical_tokens: Array.from({ length: n }, (_, i) => `t${i}`),
    });
    const chosen = representativeSequence([mk(3), mk(5), mk(9)]);
    expect(chosen.length).toBe(5);
    expect(representativeSequence([mk(4)]).length).toBe(4);
  });
});
