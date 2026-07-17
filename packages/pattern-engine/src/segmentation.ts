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

export function segmentEpisodes(events: PatternFeatureEvent[]): SegmentedEpisode[] {
  // Deterministic ordering: by occurred_at then monotonic_ms (out-of-order input tolerated).
  const sorted = [...events].sort((a, b) =>
    a.occurred_at === b.occurred_at
      ? a.monotonic_ms - b.monotonic_ms
      : a.occurred_at < b.occurred_at
        ? -1
        : 1,
  );

  const episodes: SegmentedEpisode[] = [];
  let current: PatternFeatureEvent[] = [];

  const flush = () => {
    if (current.length === 0) return;
    const episode = buildEpisode(current);
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
      if (gap > EVENT_GAP_BOUNDARY_MS || inactivity > INACTIVITY_BOUNDARY_MS) {
        flush();
        objectFamily = null;
      }
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

function buildEpisode(events: PatternFeatureEvent[]): SegmentedEpisode | null {
  const activeMs = events.reduce((sum, e) => sum + (e.duration_ms ?? 0), 0);
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
