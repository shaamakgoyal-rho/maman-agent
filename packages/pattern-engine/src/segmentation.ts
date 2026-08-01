import { uuidv7, type PatternFeatureEvent, type Sensitivity } from "@maman/contracts";

/**
 * Episode segmentation (spec §11). Pure and deterministic: identical inputs
 * yield identical episodes (episode ids derive from the first event).
 */

export const INACTIVITY_BOUNDARY_MS = 5 * 60 * 1000;
export const EVENT_GAP_BOUNDARY_MS = 10 * 60 * 1000;
export const MIN_EPISODE_EVENTS = 3;
export const MIN_EPISODE_ACTIVE_MS = 10 * 1000;
export const OBJECT_FAMILY_SWITCH_MIN_EVENTS = 3;
/** Cap on per-event active time derived from event spacing (duration absent). */
export const DERIVED_DURATION_CAP_MS = 30 * 1000;
/** Active-time credit for a final event with no successor and no duration. */
export const DERIVED_TRAILING_MS = 1000;

export type SegmentationOptions = {
  /** Gap between events that always closes an episode. */
  event_gap_boundary_ms?: number;
  /** Unexplained inactivity (gap minus recorded duration) that closes an episode. */
  inactivity_boundary_ms?: number;
  /**
   * Close the episode when its first canonical token recurs after the episode
   * already holds a full run — splits back-to-back repetitions of the same
   * workflow that have no idle gap between them.
   */
  split_on_sequence_restart?: boolean;
};

export type SegmentedEpisode = {
  episode_id: string;
  started_at: string;
  ended_at: string;
  active_duration_ms: number;
  events: PatternFeatureEvent[];
  canonical_tokens: string[];
  app_categories: string[];
  outcome_token?: string;
  sensitivity_max: Sensitivity;
  excluded_from_learning: boolean;
};

const SENSITIVITY_ORDER: Sensitivity[] = ["public", "internal", "confidential", "restricted"];

export function maxSensitivity(a: Sensitivity, b: Sensitivity): Sensitivity {
  return SENSITIVITY_ORDER.indexOf(a) >= SENSITIVITY_ORDER.indexOf(b) ? a : b;
}

/** Canonical token: source + app category + event type + role + semantic + object. */
export function canonicalToken(e: PatternFeatureEvent): string {
  return [
    e.source,
    e.app_category,
    e.event_type,
    e.target_role ?? "-",
    e.semantic_type ?? "-",
    e.object_type ?? "-",
  ].join(":");
}

/** Events that mark activity boundaries rather than work. */
function isBoundaryEvent(e: PatternFeatureEvent): boolean {
  return e.event_type === "idle_started" || e.event_type === "boundary_redacted";
}

/**
 * Active time per event. Recorded `duration_ms` is authoritative; when a live
 * source records none (the AX observer and browser relay emit point-in-time
 * events), derive it deterministically from the spacing to the next event,
 * capped so a long gap never inflates active time. Without this, live events
 * sum to zero active time and can never form an episode.
 */
function deriveDurations(sorted: PatternFeatureEvent[]): Map<string, number> {
  const derived = new Map<string, number>();
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i]!;
    if (e.duration_ms !== undefined) continue;
    const next = sorted[i + 1];
    if (!next) {
      derived.set(e.event_id, DERIVED_TRAILING_MS);
      continue;
    }
    const gap = Date.parse(next.occurred_at) - Date.parse(e.occurred_at);
    derived.set(e.event_id, Math.max(0, Math.min(gap, DERIVED_DURATION_CAP_MS)));
  }
  return derived;
}

export function segmentEpisodes(
  events: PatternFeatureEvent[],
  options: SegmentationOptions = {},
): SegmentedEpisode[] {
  const gapBoundaryMs = options.event_gap_boundary_ms ?? EVENT_GAP_BOUNDARY_MS;
  const inactivityBoundaryMs = options.inactivity_boundary_ms ?? INACTIVITY_BOUNDARY_MS;
  const splitOnRestart = options.split_on_sequence_restart ?? false;

  // Deterministic ordering: by occurred_at then monotonic_ms (out-of-order input tolerated).
  const sorted = [...events].sort((a, b) =>
    a.occurred_at === b.occurred_at
      ? a.monotonic_ms - b.monotonic_ms
      : a.occurred_at < b.occurred_at
        ? -1
        : 1,
  );
  const derivedDurations = deriveDurations(sorted);

  const episodes: SegmentedEpisode[] = [];
  let current: PatternFeatureEvent[] = [];

  const flush = () => {
    if (current.length === 0) return;
    const episode = buildEpisode(current, derivedDurations);
    if (episode) episodes.push(episode);
    current = [];
  };

  let lastTime: number | null = null;
  let objectFamily: string | null = null;

  for (const event of sorted) {
    if (isBoundaryEvent(event)) {
      // idle / denied-context / lock: hard boundary; the boundary event itself
      // is not workflow content.
      flush();
      lastTime = null;
      objectFamily = null;
      continue;
    }
    const t = Date.parse(event.occurred_at);
    if (lastTime !== null) {
      const gap = t - lastTime;
      const inactivity = gap - (event.duration_ms ?? 0);
      if (gap > gapBoundaryMs || inactivity > inactivityBoundaryMs) {
        flush();
        objectFamily = null;
      }
    }
    // Back-to-back repetition boundary (opt-in): the first token of the episode
    // recurring after a full run means the workflow restarted, not continued.
    if (
      splitOnRestart &&
      current.length >= MIN_EPISODE_EVENTS &&
      canonicalToken(event) === canonicalToken(current[0]!)
    ) {
      flush();
      objectFamily = null;
    }
    // Business-object family switch after at least three events.
    const family = event.object_type ?? null;
    if (
      family !== null &&
      objectFamily !== null &&
      family !== objectFamily &&
      current.length >= OBJECT_FAMILY_SWITCH_MIN_EVENTS
    ) {
      flush();
    }
    if (family !== null) objectFamily = family;

    current.push(event);
    lastTime = t;
  }
  flush();
  return episodes;
}

function buildEpisode(
  events: PatternFeatureEvent[],
  derivedDurations: Map<string, number>,
): SegmentedEpisode | null {
  const activeMs = events.reduce(
    (sum, e) => sum + (e.duration_ms ?? derivedDurations.get(e.event_id) ?? 0),
    0,
  );
  // Discard learning candidates that are too small to mean anything.
  if (events.length < MIN_EPISODE_EVENTS || activeMs < MIN_EPISODE_ACTIVE_MS) return null;

  const first = events[0]!;
  const last = events[events.length - 1]!;
  const sensitivity = events.reduce<Sensitivity>(
    (acc, e) => maxSensitivity(acc, e.sensitivity),
    "public",
  );
  return {
    episode_id: uuidv7({
      timestampMs: Date.parse(first.occurred_at),
      // deterministic: derive "randomness" from the first event id
      random: seededRandom(first.event_id),
    }),
    started_at: first.occurred_at,
    ended_at: last.occurred_at,
    active_duration_ms: activeMs,
    events,
    canonical_tokens: events.map(canonicalToken),
    app_categories: [...new Set(events.map((e) => e.app_category))],
    ...(lastMeaningfulToken(events) ? { outcome_token: lastMeaningfulToken(events)! } : {}),
    sensitivity_max: sensitivity,
    excluded_from_learning: events.some((e) => e.excluded_from_learning),
  };
}

function lastMeaningfulToken(events: PatternFeatureEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (["table_exported", "record_updated", "value_committed"].includes(e.event_type)) {
      return canonicalToken(e);
    }
  }
  return null;
}

function seededRandom(seed: string): () => number {
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
