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
