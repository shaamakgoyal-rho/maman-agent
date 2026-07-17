import { describe, expect, it } from "vitest";
import { patternFeatureEventSchema, patternSyncSummarySchema, uuidv7 } from "../src/index.js";

describe("patternFeatureEventSchema (privacy projection)", () => {
  const valid = {
    event_id: uuidv7(),
    occurred_at: "2026-07-17T18:00:00.000Z",
    monotonic_ms: 100,
    source: "demo" as const,
    app_category: "crm" as const,
    event_type: "record_opened" as const,
    target_role: "row",
    semantic_type: "account",
    object_type: "account",
    duration_ms: 200,
    sensitivity: "internal" as const,
    excluded_from_learning: false,
  };

  it("accepts a valid projection", () => {
    expect(patternFeatureEventSchema.parse(valid)).toBeTruthy();
  });

  it("rejects bundle_id — private app identity may not reach the pattern engine", () => {
    expect(
      patternFeatureEventSchema.safeParse({ ...valid, bundle_id: "com.private.app" }).success,
    ).toBe(false);
  });

  it("rejects domain", () => {
    expect(
      patternFeatureEventSchema.safeParse({ ...valid, domain: "secret-tool.example" }).success,
    ).toBe(false);
  });

  it("rejects record_id_hash", () => {
    expect(patternFeatureEventSchema.safeParse({ ...valid, record_id_hash: "h" }).success).toBe(
      false,
    );
  });

  it("rejects field_names", () => {
    expect(patternFeatureEventSchema.safeParse({ ...valid, field_names: ["ssn"] }).success).toBe(
      false,
    );
  });

  it("rejects label_hash and encrypted payloads", () => {
    expect(patternFeatureEventSchema.safeParse({ ...valid, label_hash: "h" }).success).toBe(false);
    expect(
      patternFeatureEventSchema.safeParse({ ...valid, encrypted_payload: "AAAA" }).success,
    ).toBe(false);
  });

  it("validates item_count_bucket values", () => {
    expect(patternFeatureEventSchema.parse({ ...valid, item_count_bucket: "11_50" })).toBeTruthy();
    expect(patternFeatureEventSchema.safeParse({ ...valid, item_count_bucket: "37" }).success).toBe(
      false,
    );
  });
});

describe("patternSyncSummarySchema (server sync redaction)", () => {
  const valid = {
    local_pattern_id: uuidv7(),
    generalized_intent: "reconcile_account_list",
    app_categories: ["crm", "spreadsheet"] as const,
    occurrence_count: 6,
    distinct_day_count: 3,
    median_duration_ms: 660000,
    similarity_mean: 0.9,
    projected_minutes_saved_weekly: 45,
    opportunity_score: 0.7,
    risk_score: 0.2,
    status: "eligible" as const,
  };

  it("accepts a valid redacted summary", () => {
    expect(patternSyncSummarySchema.parse(valid)).toBeTruthy();
  });

  it("rejects event_ids — raw event linkage may never sync", () => {
    expect(patternSyncSummarySchema.safeParse({ ...valid, event_ids: [uuidv7()] }).success).toBe(
      false,
    );
  });

  it("rejects canonical_sequence — raw tokens may contain private app identity", () => {
    expect(
      patternSyncSummarySchema.safeParse({ ...valid, canonical_sequence: ["chrome:x:y"] }).success,
    ).toBe(false);
  });

  it("rejects episode_ids", () => {
    expect(patternSyncSummarySchema.safeParse({ ...valid, episode_ids: [uuidv7()] }).success).toBe(
      false,
    );
  });

  it("bounds scores to 0..1", () => {
    expect(patternSyncSummarySchema.safeParse({ ...valid, opportunity_score: 1.2 }).success).toBe(
      false,
    );
  });
});
