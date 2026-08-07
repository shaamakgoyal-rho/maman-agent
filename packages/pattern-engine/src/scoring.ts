import { capabilitiesForToken, getCapability } from "@maman/capability-catalog";
import type { SegmentedEpisode } from "./segmentation.js";

/**
 * Deterministic scoring (spec §11). Every component normalized to 0..1.
 *
 *   opportunity = 0.25*frequency + 0.25*projected_time + 0.20*repeatability
 *               + 0.20*feasibility + 0.10*error_reduction - 0.20*risk
 */

export const OPPORTUNITY_THRESHOLD = 0.65;

export type EligibilityThresholds = {
  min_occurrences: number;
  min_distinct_days: number;
  min_similarity_mean: number;
  min_projected_minutes_weekly: number;
  min_feasibility: number;
  max_risk: number;
  dismissal_cooldown_days: number;
};

/**
 * Production eligibility bars. Volume/recency bars (occurrences, days,
 * projected minutes) and the opportunity ranking bar may be tuned at runtime
 * via EngineOptions; the safety bars (similarity, feasibility, risk) are
 * deliberately NOT overridable — see engine.ts.
 */
export const ELIGIBILITY: EligibilityThresholds = {
  min_occurrences: 3,
  min_distinct_days: 2,
  min_similarity_mean: 0.82,
  min_projected_minutes_weekly: 20,
  min_feasibility: 0.6,
  max_risk: 0.7,
  dismissal_cooldown_days: 14,
};

const WORKDAYS_PER_WEEK = 5;
/** Share of manual time an automated helper realistically returns. */
const AUTOMATABLE_SHARE = 0.8;

export function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

export function projectedMinutesSavedWeekly(episodes: SegmentedEpisode[]): number {
  const days = distinctDayCount(episodes);
  if (days === 0) return 0;
  const perDay = episodes.length / days;
  const medianMinutes = median(episodes.map((e) => e.active_duration_ms)) / 60_000;
  return perDay * WORKDAYS_PER_WEEK * medianMinutes * AUTOMATABLE_SHARE;
}

export function distinctDayCount(episodes: SegmentedEpisode[]): number {
  return new Set(episodes.map((e) => e.started_at.slice(0, 10))).size;
}

/**
 * Representative canonical sequence: the episode closest to the cluster median
 * length. Takes only the token lists it actually reads, so leave-one-out
 * validation can derive a training sequence from bare traces without
 * fabricating the rest of a SegmentedEpisode.
 */
export function representativeSequence(
  episodes: readonly Pick<SegmentedEpisode, "canonical_tokens">[],
): string[] {
  const target = median(episodes.map((e) => e.canonical_tokens.length));
  let best = episodes[0]!;
  for (const e of episodes) {
    if (
      Math.abs(e.canonical_tokens.length - target) < Math.abs(best.canonical_tokens.length - target)
    ) {
      best = e;
    }
  }
  return best.canonical_tokens;
}

/**
 * Feasibility (spec §11): mapped/total steps, penalized 0.10 per unresolved
 * input, 0.15 per UI-only write step, 0.20 if rollback impossible.
 */
export type CapabilityResolver = typeof capabilitiesForToken;

export function feasibilityScore(
  canonicalSequence: string[],
  resolve: CapabilityResolver = capabilitiesForToken,
): number {
  if (canonicalSequence.length === 0) return 0;
  let mapped = 0;
  let uiOnlyWrites = 0;
  let irreversible = false;
  let unresolvedInputs = 0;

  for (const token of canonicalSequence) {
    const candidates = resolve(token);
    if (candidates.length === 0) {
      // Unmapped write-ish steps are UI-only writes; unmapped reads are just unmapped.
      const eventType = token.split(":")[2] ?? "";
      if (["value_committed", "record_updated", "paste_semantic"].includes(eventType)) {
        uiOnlyWrites++;
      }
      continue;
    }
    mapped++;
    const meta = getCapability(candidates[0]!);
    if (meta && !meta.reversible) irreversible = true;
    // Capabilities requiring a record/file reference the pattern cannot supply
    // count as unresolved inputs.
    if (candidates[0] === "local.parse_csv") unresolvedInputs++;
  }

  const score =
    mapped / canonicalSequence.length -
    0.1 * unresolvedInputs -
    0.15 * uiOnlyWrites -
    (irreversible ? 0.2 : 0);
  return clamp01(score);
}

/** Risk: weighted share of write-type steps by their mapped capability risk. */
export function riskScore(
  canonicalSequence: string[],
  resolve: CapabilityResolver = capabilitiesForToken,
): number {
  if (canonicalSequence.length === 0) return 0;
  const riskValue: Record<string, number> = { low: 0.15, medium: 0.5, high: 0.85, prohibited: 1 };
  let total = 0;
  for (const token of canonicalSequence) {
    const candidates = resolve(token);
    const eventType = token.split(":")[2] ?? "";
    if (candidates.length === 0) {
      total += ["value_committed", "record_updated", "paste_semantic"].includes(eventType)
        ? 0.5
        : 0.1;
      continue;
    }
    const meta = getCapability(candidates[candidates.length - 1]!);
    total += riskValue[meta?.risk_level ?? "low"] ?? 0.15;
  }
  return clamp01(total / canonicalSequence.length);
}

/** Error-prone manual steps an agent eliminates: compares, copies, re-keys. */
export function errorReductionScore(canonicalSequence: string[]): number {
  if (canonicalSequence.length === 0) return 0;
  const errorProne = canonicalSequence.filter((token) => {
    const eventType = token.split(":")[2] ?? "";
    return ["copy_semantic", "paste_semantic", "value_committed", "record_updated"].includes(
      eventType,
    );
  }).length;
  return clamp01(errorProne / canonicalSequence.length + 0.2);
}

export type PatternScores = {
  frequency_score: number;
  projected_time_score: number;
  repeatability_score: number;
  feasibility_score: number;
  error_reduction_score: number;
  risk_score: number;
  opportunity_score: number;
  projected_minutes_saved_weekly: number;
};

export function scorePattern(episodes: SegmentedEpisode[], similarityMean: number): PatternScores {
  const sequence = representativeSequence(episodes);
  const projected = projectedMinutesSavedWeekly(episodes);
  const frequency = clamp01(episodes.length / 10);
  const projectedTime = clamp01(projected / 120);
  const repeatability = clamp01(similarityMean);
  const feasibility = feasibilityScore(sequence);
  const errorReduction = errorReductionScore(sequence);
  const risk = riskScore(sequence);
  const opportunity = clamp01(
    0.25 * frequency +
      0.25 * projectedTime +
      0.2 * repeatability +
      0.2 * feasibility +
      0.1 * errorReduction -
      0.2 * risk,
  );
  return {
    frequency_score: frequency,
    projected_time_score: projectedTime,
    repeatability_score: repeatability,
    feasibility_score: feasibility,
    error_reduction_score: errorReduction,
    risk_score: risk,
    opportunity_score: opportunity,
    projected_minutes_saved_weekly: projected,
  };
}
