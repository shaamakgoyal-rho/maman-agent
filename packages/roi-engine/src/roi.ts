/**
 * ROI engine (spec §20). Deterministic. Distinguishes measured, inferred, and
 * estimated metrics and never presents estimates as confirmed.
 *
 *   verified_net_hours =
 *     max(0, manual_baseline_minutes
 *            - automated_elapsed_human_minutes
 *            - human_intervention_minutes) / 60
 *
 *   net_value_usd =
 *     verified_net_hours * loaded_hourly_rate
 *     - model_cost - connector_cost - infrastructure_cost
 */

export const MEASURED_BASELINE_MIN_OBSERVATIONS = 3;

export type MetricProvenance = "measured" | "inferred" | "estimated";

// ---- baseline ----

export type BaselineInput = {
  episode_durations_ms: number[]; // observed manual episodes
  p90_ms: number; // cap per episode to reduce idle inflation
  similarity_mean: number;
  user_confirmed: boolean;
};

export type Baseline = {
  median_manual_duration_ms: number;
  occurrence_count: number;
  confidence: number;
  provenance: MetricProvenance;
};

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function computeBaseline(input: BaselineInput): Baseline {
  // Cap each episode at p90 to reduce idle-time inflation.
  const capped = input.episode_durations_ms.map((d) => Math.min(d, input.p90_ms));
  const count = capped.length;
  const confidence = Math.min(1, count / 10) * input.similarity_mean;
  const provenance: MetricProvenance = input.user_confirmed
    ? "measured"
    : count >= MEASURED_BASELINE_MIN_OBSERVATIONS
      ? "inferred"
      : "estimated";
  return {
    median_manual_duration_ms: Math.round(median(capped)),
    occurrence_count: count,
    confidence: Math.round(confidence * 100_000) / 100_000,
    provenance,
  };
}

// ---- per-run verified value ----

export type VerifiedTimeInput = {
  baseline_ms: number;
  automated_human_ms: number; // attention time only, not server elapsed
  intervention_ms: number;
  verification_status: "projected" | "verified" | "disputed";
};

export function verifiedSavedMs(input: VerifiedTimeInput): number {
  // Disputed runs contribute zero verified savings.
  if (input.verification_status !== "verified") return 0;
  return Math.max(0, input.baseline_ms - input.automated_human_ms - input.intervention_ms);
}

export type NetValueInput = {
  verified_saved_ms: number;
  loaded_hourly_rate_usd: number | null;
  model_cost_usd: number;
  connector_cost_usd: number;
  infrastructure_cost_usd: number;
};

export type NetValue = {
  verified_net_hours: number;
  gross_value_usd: number | null;
  net_value_usd: number | null;
};

export function computeNetValue(input: NetValueInput): NetValue {
  const hours = Math.max(0, input.verified_saved_ms) / 3_600_000;
  const totalCost = input.model_cost_usd + input.connector_cost_usd + input.infrastructure_cost_usd;
  if (input.loaded_hourly_rate_usd === null) {
    // Never infer an hourly rate — value stays null until configured.
    return { verified_net_hours: round(hours), gross_value_usd: null, net_value_usd: null };
  }
  const gross = hours * input.loaded_hourly_rate_usd;
  return {
    verified_net_hours: round(hours),
    gross_value_usd: round(gross),
    net_value_usd: round(gross - totalCost),
  };
}

function round(x: number): number {
  return Math.round(x * 1_000_000) / 1_000_000;
}

// ---- receipt ROI block (used by the worker) ----

export type ReceiptRoiInput = {
  manual_baseline_ms: number;
  baseline_observation_count: number;
  automated_human_ms: number;
  human_review_ms: number;
  mode: "shadow" | "supervised" | "active";
};

export type ReceiptRoi = {
  manual_baseline_ms: number;
  baseline_provenance: MetricProvenance;
  baseline_observation_count: number;
  gross_time_saved_ms: number;
  human_review_ms: number;
  net_time_saved_ms: number;
  savings_provenance: MetricProvenance;
};

export function computeReceiptRoi(input: ReceiptRoiInput): ReceiptRoi {
  const baselineProvenance: MetricProvenance =
    input.baseline_observation_count >= MEASURED_BASELINE_MIN_OBSERVATIONS
      ? "measured"
      : "estimated";
  // Shadow runs never wrote anything — savings are projected only.
  if (input.mode === "shadow") {
    return {
      manual_baseline_ms: input.manual_baseline_ms,
      baseline_provenance: baselineProvenance,
      baseline_observation_count: input.baseline_observation_count,
      gross_time_saved_ms: 0,
      human_review_ms: input.human_review_ms,
      net_time_saved_ms: 0,
      savings_provenance: "estimated",
    };
  }
  const gross = Math.max(0, input.manual_baseline_ms);
  const net = Math.max(0, gross - input.automated_human_ms - input.human_review_ms);
  return {
    manual_baseline_ms: input.manual_baseline_ms,
    baseline_provenance: baselineProvenance,
    baseline_observation_count: input.baseline_observation_count,
    gross_time_saved_ms: gross,
    human_review_ms: input.human_review_ms,
    net_time_saved_ms: net,
    // Savings are only as trustworthy as the baseline behind them.
    savings_provenance: baselineProvenance === "measured" ? "measured" : "estimated",
  };
}

// ---- aggregate reporting (cohort suppression) ----

export const MIN_COHORT_SIZE = 5;

export type AggregateInput = {
  per_user_verified_hours: number[];
  per_user_net_value_usd: number[];
};

export type Aggregate =
  | { suppressed: true; reason: string; cohort_size: number }
  | {
      suppressed: false;
      cohort_size: number;
      total_verified_hours: number;
      total_net_value_usd: number;
    };

export function aggregate(input: AggregateInput, minCohort = MIN_COHORT_SIZE): Aggregate {
  const cohort = input.per_user_verified_hours.length;
  if (cohort < minCohort) {
    return {
      suppressed: true,
      reason: `cohort of ${cohort} is below the minimum of ${minCohort}`,
      cohort_size: cohort,
    };
  }
  return {
    suppressed: false,
    cohort_size: cohort,
    total_verified_hours: round(input.per_user_verified_hours.reduce((a, b) => a + b, 0)),
    total_net_value_usd: round(input.per_user_net_value_usd.reduce((a, b) => a + b, 0)),
  };
}
