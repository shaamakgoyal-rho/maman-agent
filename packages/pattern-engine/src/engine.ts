import {
  uuidv7,
  type PatternCandidate,
  type PatternFeatureEvent,
  type Recommendation,
} from "@maman/contracts";
import {
  matchEpisode,
  templateReps,
  type DomainPack,
  type TemplateMatch,
  type TemplateStepInput,
} from "@maman/domain-packs";
import {
  segmentEpisodes,
  type SegmentationOptions,
  type SegmentedEpisode,
} from "./segmentation.js";
import { clusterEpisodes, sequenceSimilarity, DEFAULT_SIMILARITY_THRESHOLD } from "./similarity.js";
import {
  distinctDayCount,
  ELIGIBILITY,
  median,
  OPPORTUNITY_THRESHOLD,
  percentile,
  representativeSequence,
  scorePattern,
  type EligibilityThresholds,
} from "./scoring.js";
import { deterministicName, type NamingResult } from "./naming.js";

/**
 * End-to-end deterministic pattern pipeline:
 * feature events → episodes → clusters → scored candidates → eligibility.
 * No LLM anywhere in this package (naming here is the deterministic fallback;
 * optional model naming lives in model-provider and may only rewrite copy).
 */

/**
 * The only eligibility bars callers may tune: volume/recency/value bars.
 * The safety bars (min_similarity_mean, min_feasibility, max_risk) are
 * deliberately absent — no option can loosen them.
 */
export type TunableEligibility = Pick<
  EligibilityThresholds,
  "min_occurrences" | "min_distinct_days" | "min_projected_minutes_weekly"
>;

export type EngineOptions = {
  owner_user_id: string;
  /** Injectable clock for determinism. */
  now: () => Date;
  similarity_threshold?: number;
  /** Pattern signatures dismissed within the cooldown (canonical join). */
  recently_dismissed_signatures?: string[];
  /** Permanently suppressed signatures ("never suggest this"). */
  suppressed_signatures?: string[];
  /** Tunable volume bars (clamped to sane floors); safety bars are not tunable. */
  eligibility?: Partial<TunableEligibility>;
  /** Ranking bar for surfacing (0..1); not a safety bar. */
  opportunity_threshold?: number;
  /** Episode boundary tuning (gap boundary, back-to-back repetition split). */
  segmentation?: SegmentationOptions;
  /**
   * Domain packs for template-primed detection (L2). Template recognition runs
   * BEFORE novel clustering and lowers only the repetition bar
   * (min_reps_with_template, counted per the workflow's cadence). The safety
   * bars — feasibility and risk — apply to template candidates unchanged.
   */
  packs?: DomainPack[];
};

/** Effective bars: overrides merged over production defaults, clamped. */
export function effectiveEligibility(
  overrides?: Partial<TunableEligibility>,
): EligibilityThresholds {
  return {
    ...ELIGIBILITY,
    min_occurrences: Math.max(2, overrides?.min_occurrences ?? ELIGIBILITY.min_occurrences),
    min_distinct_days: Math.max(1, overrides?.min_distinct_days ?? ELIGIBILITY.min_distinct_days),
    min_projected_minutes_weekly: Math.max(
      0,
      overrides?.min_projected_minutes_weekly ?? ELIGIBILITY.min_projected_minutes_weekly,
    ),
  };
}

/**
 * A pattern Maman is watching form but that has NOT yet crossed every
 * eligibility bar — surfaced (with its plain-language naming) so the UI can
 * show the user what is being tracked and how close it is to a suggestion.
 */
export type WatchingPattern = {
  candidate: PatternCandidate;
  naming: NamingResult;
};

export type EngineResult = {
  episodes: SegmentedEpisode[];
  candidates: PatternCandidate[];
  /** Recommendations for candidates that crossed every eligibility bar. */
  recommendations: Recommendation[];
  /** In-progress patterns (status "candidate") not yet surfaceable, with naming. */
  watching: WatchingPattern[];
};

export function patternSignature(canonicalSequence: string[]): string {
  return canonicalSequence.join("|");
}

export function runPatternEngine(
  events: PatternFeatureEvent[],
  options: EngineOptions,
): EngineResult {
  const threshold = options.similarity_threshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const eligibility = effectiveEligibility(options.eligibility);
  const opportunityThreshold = Math.min(
    1,
    Math.max(0, options.opportunity_threshold ?? OPPORTUNITY_THRESHOLD),
  );
  const episodes = segmentEpisodes(events, options.segmentation ?? {});

  // Learn only from includable episodes; excluded ones still display in the
  // timeline but never feed a pattern.
  const learnable = episodes.filter(
    (e) => !e.excluded_from_learning && e.sensitivity_max !== "restricted",
  );

  const candidates: PatternCandidate[] = [];
  const recommendations: Recommendation[] = [];
  const watching: WatchingPattern[] = [];

  // ---- L2: template-primed detection, BEFORE novel clustering ----
  // Episodes recognized by a pack workflow are grouped per workflow and
  // removed from the clustering input: they are already explained.
  const templateGroups = new Map<string, { match: TemplateMatch; members: SegmentedEpisode[] }>();
  const unexplained: SegmentedEpisode[] = [];
  for (const episode of learnable) {
    const match = options.packs?.length
      ? matchEpisode(options.packs, episode.events.map(toTemplateStep))
      : null;
    if (match) {
      const key = `${match.pack_domain}/${match.workflow_id}`;
      const group = templateGroups.get(key) ?? { match, members: [] };
      group.members.push(episode);
      templateGroups.set(key, group);
    } else {
      unexplained.push(episode);
    }
  }

  for (const [templateId, { match, members }] of [...templateGroups.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const built = buildTemplateCandidate(templateId, match, members, eligibility, options);
    candidates.push(built.candidate);
    if (built.recommendation) recommendations.push(built.recommendation);
    else if (built.watching) watching.push(built.watching);
  }

  const clusters = clusterEpisodes(
    unexplained.map((e) => ({
      tokens: e.canonical_tokens,
      active_duration_ms: e.active_duration_ms,
      app_categories: e.app_categories,
    })),
    threshold,
  );

  for (const cluster of clusters) {
    const members = cluster.members.map((i) => unexplained[i]!);
    if (members.length < 2) continue; // singletons are never candidates

    const scores = scorePattern(members, cluster.similarity_mean);
    const sequence = representativeSequence(members);
    const durations = members.map((m) => m.active_duration_ms);
    const firstSeen = members.map((m) => m.started_at).sort()[0]!;
    const lastSeen = members
      .map((m) => m.ended_at)
      .sort()
      .at(-1)!;
    const days = distinctDayCount(members);
    const signature = patternSignature(sequence);

    const suppressed = options.suppressed_signatures?.includes(signature) ?? false;
    const dismissedRecently = options.recently_dismissed_signatures?.includes(signature) ?? false;

    const eligible =
      members.length >= eligibility.min_occurrences &&
      days >= eligibility.min_distinct_days &&
      cluster.similarity_mean >= eligibility.min_similarity_mean &&
      scores.projected_minutes_saved_weekly >= eligibility.min_projected_minutes_weekly &&
      scores.feasibility_score >= eligibility.min_feasibility &&
      scores.risk_score <= eligibility.max_risk &&
      !members.some((m) => m.excluded_from_learning) &&
      !members.some((m) => m.sensitivity_max === "restricted") &&
      !dismissedRecently &&
      !suppressed;

    const surfaceable = eligible && scores.opportunity_score >= opportunityThreshold;

    const candidate: PatternCandidate = {
      pattern_id: uuidv7({
        timestampMs: Date.parse(firstSeen),
        random: seeded(signature),
      }),
      owner_user_id: options.owner_user_id,
      first_seen_at: firstSeen,
      last_seen_at: lastSeen,
      occurrence_count: members.length,
      distinct_day_count: days,
      median_duration_ms: Math.round(median(durations)),
      p90_duration_ms: Math.round(percentile(durations, 90)),
      canonical_sequence: sequence,
      episode_ids: members.map((m) => m.episode_id),
      similarity_mean: round5(cluster.similarity_mean),
      repeatability_score: round5(scores.repeatability_score),
      feasibility_score: round5(scores.feasibility_score),
      risk_score: round5(scores.risk_score),
      projected_minutes_saved_weekly: Math.round(scores.projected_minutes_saved_weekly * 100) / 100,
      opportunity_score: round5(scores.opportunity_score),
      status: surfaceable ? "eligible" : "candidate",
      ...(observedDomainActions(members).length > 0
        ? { domain_actions: observedDomainActions(members) }
        : {}),
    };
    candidates.push(candidate);

    if (surfaceable) {
      recommendations.push(buildRecommendation(candidate, members, options));
    } else if (!suppressed && !dismissedRecently) {
      // In-progress pattern the user hasn't waved off — show it forming, with
      // its plain-language naming, so tracking → suggestion is transparent.
      watching.push({ candidate, naming: deterministicName(candidate, members) });
    }
  }

  return { episodes, candidates, recommendations, watching };
}

function toTemplateStep(event: PatternFeatureEvent): TemplateStepInput {
  return {
    ...(event.domain_action ? { domain_action: event.domain_action } : {}),
    ...(event.domain_object ? { domain_object: event.domain_object } : {}),
    ...(event.target_role ? { target_role: event.target_role } : {}),
    event_type: event.event_type,
  };
}

/** Distinct pack actions across an episode group, in first-seen order. */
function observedDomainActions(members: SegmentedEpisode[]): string[] {
  const seen: string[] = [];
  for (const episode of members) {
    for (const event of episode.events) {
      const action = event.domain_action;
      if (action && !seen.includes(action)) seen.push(action);
    }
  }
  return seen;
}

/** Mean pairwise sequence similarity — honest even for a 2-member group. */
function meanSimilarity(members: SegmentedEpisode[]): number {
  if (members.length < 2) return 1;
  let total = 0;
  let count = 0;
  for (let a = 0; a < members.length; a++) {
    for (let b = a + 1; b < members.length; b++) {
      total += sequenceSimilarity(members[a]!.canonical_tokens, members[b]!.canonical_tokens);
      count++;
    }
  }
  return count === 0 ? 1 : total / count;
}

/**
 * Builds the candidate (+ recommendation or watching entry) for one template
 * group. Template recognition replaces the VOLUME bars with the workflow's
 * cadence-aware `min_reps_with_template`; the SAFETY bars — feasibility and
 * risk — are enforced unchanged (a template can never be a way around them),
 * and suppression/dismissal are honored exactly like novel patterns.
 */
function buildTemplateCandidate(
  templateId: string,
  match: TemplateMatch,
  members: SegmentedEpisode[],
  eligibility: EligibilityThresholds,
  options: EngineOptions,
): {
  candidate: PatternCandidate;
  recommendation?: Recommendation;
  watching?: WatchingPattern;
} {
  const similarityMean = meanSimilarity(members);
  const scores = scorePattern(members, similarityMean);
  const sequence = representativeSequence(members);
  const durations = members.map((m) => m.active_duration_ms);
  const firstSeen = members.map((m) => m.started_at).sort()[0]!;
  const lastSeen = members
    .map((m) => m.ended_at)
    .sort()
    .at(-1)!;
  const signature = patternSignature(sequence);
  const reps = templateReps(
    members.map((m) => m.started_at),
    match.cadence,
  );

  const suppressed = options.suppressed_signatures?.includes(signature) ?? false;
  const dismissedRecently = options.recently_dismissed_signatures?.includes(signature) ?? false;
  const safe =
    scores.feasibility_score >= eligibility.min_feasibility &&
    scores.risk_score <= eligibility.max_risk;
  const surfaceable =
    reps >= match.min_reps_with_template && safe && !suppressed && !dismissedRecently;

  const candidate: PatternCandidate = {
    pattern_id: uuidv7({ timestampMs: Date.parse(firstSeen), random: seeded(templateId) }),
    owner_user_id: options.owner_user_id,
    first_seen_at: firstSeen,
    last_seen_at: lastSeen,
    occurrence_count: members.length,
    distinct_day_count: distinctDayCount(members),
    median_duration_ms: Math.round(median(durations)),
    p90_duration_ms: Math.round(percentile(durations, 90)),
    canonical_sequence: sequence,
    episode_ids: members.map((m) => m.episode_id),
    similarity_mean: round5(similarityMean),
    repeatability_score: round5(scores.repeatability_score),
    feasibility_score: round5(scores.feasibility_score),
    risk_score: round5(scores.risk_score),
    projected_minutes_saved_weekly: Math.round(scores.projected_minutes_saved_weekly * 100) / 100,
    opportunity_score: round5(scores.opportunity_score),
    status: surfaceable ? "eligible" : "candidate",
    template_id: templateId,
    ...(observedDomainActions(members).length > 0
      ? { domain_actions: observedDomainActions(members) }
      : {}),
  };

  if (suppressed || dismissedRecently) return { candidate };

  const naming = deterministicName(candidate, members);
  const template = {
    pack_domain: match.pack_domain,
    workflow_id: match.workflow_id,
    workflow_name: match.workflow_name,
    cadence: match.cadence as string,
    reps,
    min_reps: match.min_reps_with_template,
  };

  if (!surfaceable) {
    // Still forming (or blocked by a safety bar) — visible, with the template
    // naming so the forming card can say what it recognized.
    return {
      candidate,
      watching: {
        candidate,
        naming: { ...naming, title: match.workflow_name },
      },
    };
  }

  const medianMinutes = Math.round(candidate.median_duration_ms / 60_000);
  const repWord =
    match.cadence === "fiscal_monthly" ? "month" : match.cadence === "weekly" ? "week" : "time";
  const recommendation: Recommendation = {
    recommendation_id: uuidv7({ timestampMs: options.now().getTime(), random: seeded(templateId) }),
    pattern_id: candidate.pattern_id,
    owner_user_id: candidate.owner_user_id,
    title: match.workflow_name,
    summary:
      `This matches ${match.workflow_name}, a known ${match.pack_domain} workflow — ` +
      `I've seen you do it ${reps} ${repWord}${reps === 1 ? "" : "s"} in a row` +
      `${medianMinutes > 0 ? `, about ${medianMinutes} minutes each` : ""}. ` +
      `I can draft a helper and show you what it would do before anything changes.`,
    generalized_intent: naming.generalized_intent,
    template,
    evidence: {
      occurrence_count: candidate.occurrence_count,
      distinct_day_count: candidate.distinct_day_count,
      median_duration_ms: candidate.median_duration_ms,
      redacted_steps: naming.redacted_steps,
    },
    projected_minutes_saved_weekly: candidate.projected_minutes_saved_weekly,
    expected_cost_usd_low: 0.02,
    expected_cost_usd_high: 0.25,
    // Confidence reflects template recognition + observed reps, capped well
    // below certainty at the minimum rep count.
    confidence: round5(Math.min(1, 0.5 + 0.1 * reps)),
    risk_level:
      candidate.risk_score <= 0.3 ? "low" : candidate.risk_score <= 0.6 ? "medium" : "high",
    required_capabilities: naming.required_capabilities,
    status: "new",
    created_at: options.now().toISOString(),
  };
  return { candidate, recommendation };
}

function buildRecommendation(
  candidate: PatternCandidate,
  members: SegmentedEpisode[],
  options: EngineOptions,
): Recommendation {
  const naming = deterministicName(candidate, members);
  const riskLevel =
    candidate.risk_score <= 0.3 ? "low" : candidate.risk_score <= 0.6 ? "medium" : "high";
  return {
    recommendation_id: uuidv7({
      timestampMs: options.now().getTime(),
      random: seeded(candidate.pattern_id),
    }),
    pattern_id: candidate.pattern_id,
    owner_user_id: candidate.owner_user_id,
    title: naming.title,
    summary: naming.summary,
    generalized_intent: naming.generalized_intent,
    evidence: {
      occurrence_count: candidate.occurrence_count,
      distinct_day_count: candidate.distinct_day_count,
      median_duration_ms: candidate.median_duration_ms,
      redacted_steps: naming.redacted_steps,
    },
    projected_minutes_saved_weekly: candidate.projected_minutes_saved_weekly,
    // Cost range: deterministic estimate refined by real usage at M7+.
    expected_cost_usd_low: 0.02,
    expected_cost_usd_high: 0.25,
    confidence: round5(
      Math.min(1, (candidate.occurrence_count / 10) * candidate.similarity_mean + 0.3),
    ),
    risk_level: riskLevel,
    required_capabilities: naming.required_capabilities,
    status: "new",
    created_at: options.now().toISOString(),
  };
}

function round5(x: number): number {
  return Math.round(x * 100_000) / 100_000;
}

function seeded(seed: string): () => number {
  let h = 2166136261;
  for (const c of seed) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
}
