import { describe, expect, it } from "vitest";
import {
  patternCandidateSchema,
  patternFeatureEventSchema,
  patternSyncSummarySchema,
  uuidv7,
} from "../src/index.js";

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

  it("still rejects `domain` — that name means a WEB domain and must never reach the engine", () => {
    // Domain-pack classification uses pack_domain precisely so this stays true.
    expect(
      patternFeatureEventSchema.safeParse({ ...valid, domain: "secret-tool.example" }).success,
    ).toBe(false);
  });

  it("accepts pack taxonomy ids but structurally rejects a hostname in them", () => {
    expect(
      patternFeatureEventSchema.safeParse({
        ...valid,
        pack_domain: "finops",
        domain_object: "invoice",
        domain_action: "code_invoice",
        classifier_confidence: 0.8,
      }).success,
    ).toBe(true);
    // Dots and hyphens cannot appear in a pack id, so app identity cannot ride in.
    for (const leak of ["secret-tool.example", "acme.lightning.force.com", "my-app"]) {
      expect(patternFeatureEventSchema.safeParse({ ...valid, pack_domain: leak }).success).toBe(
        false,
      );
      expect(patternFeatureEventSchema.safeParse({ ...valid, domain_object: leak }).success).toBe(
        false,
      );
    }
  });

  it("rejects a confidence outside 0..1", () => {
    expect(
      patternFeatureEventSchema.safeParse({ ...valid, classifier_confidence: 1.5 }).success,
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

describe("representative_trace_ref (the candidate → trace join)", () => {
  const candidate = {
    pattern_id: uuidv7(),
    owner_user_id: uuidv7(),
    first_seen_at: "2026-07-14T09:00:00.000Z",
    last_seen_at: "2026-07-16T09:00:00.000Z",
    occurrence_count: 6,
    distinct_day_count: 3,
    median_duration_ms: 600000,
    p90_duration_ms: 700000,
    canonical_sequence: ["chrome:crm:-:-:-:account"],
    episode_ids: [uuidv7()],
    similarity_mean: 0.9,
    repeatability_score: 0.8,
    feasibility_score: 0.7,
    risk_score: 0.2,
    projected_minutes_saved_weekly: 45,
    opportunity_score: 0.8,
    status: "eligible" as const,
  };

  it("a candidate may carry the join, and it must be an opaque UUID", () => {
    expect(
      patternCandidateSchema.parse({ ...candidate, representative_trace_ref: uuidv7() }),
    ).toBeTruthy();
    expect(
      patternCandidateSchema.safeParse({
        ...candidate,
        representative_trace_ref: "salesforce.com/leads/42",
      }).success,
    ).toBe(false);
  });

  it("stays optional — candidates that predate stamping remain valid", () => {
    expect(patternCandidateSchema.parse(candidate)).toBeTruthy();
  });

  it("may NEVER sync: the summary schema rejects it", () => {
    const summary = {
      local_pattern_id: uuidv7(),
      generalized_intent: "reconcile accounts",
      app_categories: ["crm" as const],
      occurrence_count: 6,
      distinct_day_count: 3,
      median_duration_ms: 600000,
      similarity_mean: 0.9,
      projected_minutes_saved_weekly: 45,
      opportunity_score: 0.8,
      risk_score: 0.2,
      status: "eligible" as const,
    };
    expect(patternSyncSummarySchema.parse(summary)).toBeTruthy();
    expect(
      patternSyncSummarySchema.safeParse({ ...summary, representative_trace_ref: uuidv7() })
        .success,
    ).toBe(false);
  });
});
