import { z } from "zod";
import { appCategory, eventSource, sensitivity, utcTimestamp, uuid } from "./common.js";
import { workflowEventType } from "./workflow-event.js";

/**
 * PatternFeatureEvent — the ONLY projection the local pattern engine (and the
 * React layer) may receive. It deliberately excludes bundle IDs, domains,
 * record hashes, field names, labels, and encrypted payloads.
 */
export const patternFeatureEventSchema = z
  .object({
    event_id: uuid,
    occurred_at: utcTimestamp,
    monotonic_ms: z.number().int().nonnegative(),
    source: eventSource,
    app_category: appCategory,
    event_type: workflowEventType,
    target_role: z.string().optional(),
    semantic_type: z.string().optional(),
    object_type: z.string().optional(),
    item_count_bucket: z.enum(["1", "2_10", "11_50", "51_200", "201_plus"]).optional(),
    duration_ms: z.number().int().nonnegative().optional(),
    sensitivity,
    excluded_from_learning: z.boolean(),
  })
  .strict();

export type PatternFeatureEvent = z.infer<typeof patternFeatureEventSchema>;

export const workflowEpisodeSchema = z
  .object({
    episode_id: uuid,
    started_at: utcTimestamp,
    ended_at: utcTimestamp,
    active_duration_ms: z.number().int().nonnegative(),
    event_ids: z.array(uuid),
    canonical_tokens: z.array(z.string()),
    apps: z.array(z.string()),
    outcome_token: z.string().optional(),
    sensitivity_max: sensitivity,
    excluded_from_learning: z.boolean(),
  })
  .strict();

export type WorkflowEpisode = z.infer<typeof workflowEpisodeSchema>;

export const patternCandidateStatus = z.enum([
  "candidate",
  "eligible",
  "suggested",
  "dismissed",
  "converted",
]);
export type PatternCandidateStatus = z.infer<typeof patternCandidateStatus>;

const score = z.number().min(0).max(1);

export const patternCandidateSchema = z
  .object({
    pattern_id: uuid,
    owner_user_id: uuid,
    first_seen_at: utcTimestamp,
    last_seen_at: utcTimestamp,
    occurrence_count: z.number().int().nonnegative(),
    distinct_day_count: z.number().int().nonnegative(),
    median_duration_ms: z.number().int().nonnegative(),
    p90_duration_ms: z.number().int().nonnegative(),
    canonical_sequence: z.array(z.string()),
    episode_ids: z.array(uuid),
    similarity_mean: score,
    repeatability_score: score,
    feasibility_score: score,
    risk_score: score,
    projected_minutes_saved_weekly: z.number().nonnegative(),
    opportunity_score: score,
    status: patternCandidateStatus,
  })
  .strict();

export type PatternCandidate = z.infer<typeof patternCandidateSchema>;

/**
 * The redacted pattern summary that may sync to the server. Never includes
 * event_ids or raw canonical tokens that contain private app identity —
 * app identity is reduced to categories.
 */
export const patternSyncSummarySchema = z
  .object({
    local_pattern_id: uuid,
    generalized_intent: z.string(),
    app_categories: z.array(appCategory),
    occurrence_count: z.number().int().nonnegative(),
    distinct_day_count: z.number().int().nonnegative(),
    median_duration_ms: z.number().int().nonnegative(),
    similarity_mean: score,
    projected_minutes_saved_weekly: z.number().nonnegative(),
    opportunity_score: score,
    risk_score: score,
    status: patternCandidateStatus,
  })
  .strict();

export type PatternSyncSummary = z.infer<typeof patternSyncSummarySchema>;
