import { z } from "zod";
import { riskLevel, utcTimestamp, uuid } from "./common.js";

export const recommendationStatus = z.enum([
  "new",
  "viewed",
  "snoozed",
  "dismissed",
  "blocked",
  "accepted",
]);
export type RecommendationStatus = z.infer<typeof recommendationStatus>;

export const dismissalReason = z.enum([
  "irrelevant",
  "already_automated",
  "too_risky",
  "not_enough_value",
  "wrong_pattern",
  "never_suggest",
]);
export type DismissalReason = z.infer<typeof dismissalReason>;

export const recommendationEvidenceSchema = z
  .object({
    occurrence_count: z.number().int().nonnegative(),
    distinct_day_count: z.number().int().nonnegative(),
    median_duration_ms: z.number().int().nonnegative(),
    redacted_steps: z.array(
      z
        .object({
          order: z.number().int().positive(),
          app: z.string(),
          action: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

export const recommendationSchema = z
  .object({
    recommendation_id: uuid,
    pattern_id: uuid,
    owner_user_id: uuid,
    title: z.string().min(1),
    summary: z.string().min(1),
    /**
     * Deterministic generalized intent from naming (e.g. update_account_records)
     * — the compiler's recipe selector input. Optional for wire compatibility.
     */
    generalized_intent: z.string().optional(),
    /**
     * Present when this suggestion comes from a pack workflow TEMPLATE match
     * rather than novel-pattern clustering. The card must present this as its
     * own claim ("matches a known workflow, seen N×") and must NOT show a
     * replay score until enough runs exist for one to mean anything — at
     * small N the replay verifier is self-referential.
     */
    template: z
      .object({
        pack_domain: z.string(),
        workflow_id: z.string(),
        workflow_name: z.string(),
        cadence: z.string(),
        reps: z.number().int().nonnegative(),
        min_reps: z.number().int().positive(),
      })
      .strict()
      .optional(),
    evidence: recommendationEvidenceSchema,
    projected_minutes_saved_weekly: z.number().nonnegative(),
    expected_cost_usd_low: z.number().nonnegative(),
    expected_cost_usd_high: z.number().nonnegative(),
    confidence: z.number().min(0).max(1),
    risk_level: riskLevel,
    required_capabilities: z.array(z.string()),
    status: recommendationStatus,
    surfaced_at: utcTimestamp.optional(),
    created_at: utcTimestamp,
  })
  .strict();

export type Recommendation = z.infer<typeof recommendationSchema>;
