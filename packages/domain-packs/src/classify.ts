import type { DomainPack, PackObject } from "./schema.js";

/**
 * Domain classifier (L1) — maps one observed event onto a pack's taxonomy.
 *
 * Deliberately generic: it reads `detection_hints` from whatever packs it is
 * given and knows nothing about FinOps or RevOps.
 *
 * Two boundaries shape the design:
 *
 * 1. LABEL TEXT NEVER LEAVES THE OBSERVER. Label patterns can only be matched
 *    where the raw text lives (inside the macOS observer, pre-hash), so callers
 *    pass the ALREADY-MATCHED result as `label_pattern_hits` — pattern strings
 *    that fired, never the text they fired against. The Rust ingest path, which
 *    has no label text, simply passes none.
 * 2. NEVER FORCE A MAPPING. No match means `null`, and the event stays
 *    unclassified rather than being coerced into a domain.
 *
 * Pure and deterministic: identical input always yields the identical tuple, so
 * classification can be re-derived and audited.
 */

/** What the caller can observe about an event, in privacy-safe terms. */
export type ClassifierInput = {
  /** Coarse app category (crm, spreadsheet, …) or a pack-declared category. */
  app_category?: string;
  /** Observed event type (value_committed, record_opened, …). */
  event_type: string;
  /** Accessibility/DOM role of the target, if any. */
  target_role?: string;
  /** Existing semantic hint from the source (e.g. a form field's name). */
  semantic_type?: string;
  /** Business-object hint already derived (e.g. from a page URL). */
  object_type?: string;
  /**
   * Pack `label_patterns` that matched inside the observer boundary. Pattern
   * strings only — never the label text itself.
   */
  label_pattern_hits?: string[];
};

export type Classification = {
  domain: string;
  object?: string;
  action?: string;
  /** 0..1 — how much evidence supported this mapping. */
  confidence: number;
};

/**
 * Event types that read vs. change, used to pick a plausible pack action when
 * the pack itself does not pin one. Kept generic: this is observation
 * vocabulary, not domain knowledge.
 */
const WRITE_EVENT_TYPES = new Set([
  "value_committed",
  "record_updated",
  "paste_semantic",
  "table_exported",
]);
const READ_EVENT_TYPES = new Set([
  "record_opened",
  "table_read",
  "navigation",
  "element_focused",
  "element_activated",
  "app_activated",
  "window_focused",
  "copy_semantic",
]);

/** Evidence weights. Explicit hints outrank inferred ones. */
const W_LABEL_HIT = 0.45;
const W_APP_CATEGORY = 0.3;
const W_OBJECT_TYPE_MATCH = 0.4;
const W_ROLE_HIT = 0.15;
const W_SEMANTIC_HINT = 0.2;

function objectCandidates(pack: DomainPack, input: ClassifierInput): Array<[PackObject, number]> {
  const scored: Array<[PackObject, number]> = [];
  const hits = new Set(input.label_pattern_hits ?? []);

  for (const object of pack.objects) {
    let score = 0;
    // App category is CONTEXT, not identification: on its own it must never
    // classify (otherwise every CRM event would be typed as some default
    // object). At least one identifying signal is required.
    let identified = false;
    const hints = object.detection_hints;

    // An already-derived object_type naming this object (or an alias) is the
    // strongest signal available without label text.
    const names = [object.id, ...object.aliases];
    if (input.object_type && names.includes(input.object_type)) {
      score += W_OBJECT_TYPE_MATCH;
      identified = true;
    }
    if (input.semantic_type && names.some((n) => input.semantic_type!.includes(n))) {
      score += W_SEMANTIC_HINT;
      identified = true;
    }
    if (hints.label_patterns.some((p) => hits.has(p))) {
      score += W_LABEL_HIT;
      identified = true;
    }
    if (input.app_category && hints.app_categories.includes(input.app_category)) {
      score += W_APP_CATEGORY;
    }
    if (input.target_role && hints.target_roles.includes(input.target_role)) {
      score += W_ROLE_HIT;
      identified = true;
    }

    if (identified && score > 0) scored.push([object, score]);
  }
  // Deterministic ordering: score desc, then id asc so ties never depend on
  // pack authoring order.
  return scored.sort((a, b) => b[1] - a[1] || a[0].id.localeCompare(b[0].id));
}

/**
 * Picks the pack action for an event. Only actions the pack declares as
 * applicable to the resolved object are eligible, so a classification can never
 * assert an action the pack says is impossible for that object.
 */
function chooseAction(pack: DomainPack, objectId: string | undefined, eventType: string) {
  const applicable = pack.actions.filter((a) => {
    if (a.on.length === 0 || a.on.includes("*")) return true;
    return objectId !== undefined && a.on.includes(objectId);
  });
  if (applicable.length === 0) return undefined;

  const isWrite = WRITE_EVENT_TYPES.has(eventType);
  const isRead = READ_EVENT_TYPES.has(eventType);

  // A read event must never be classified as a mutating action — that would
  // let an observation imply a change the worker never made.
  const eligible = applicable.filter((a) => {
    if (isWrite) return a.risk !== "none";
    if (isRead) return a.risk === "none" || a.risk === "low";
    return true;
  });
  const pool = eligible.length > 0 ? eligible : [];
  if (pool.length === 0) return undefined;

  // Lowest-risk plausible action, tie-broken by id: classification should never
  // inflate risk, and policy re-derives risk from the pack anyway.
  const order = ["none", "low", "medium", "high", "critical"];
  return [...pool].sort(
    (a, b) => order.indexOf(a.risk) - order.indexOf(b.risk) || a.id.localeCompare(b.id),
  )[0];
}

/**
 * Classifies one event against the given packs. Returns null when nothing
 * matched — callers must leave the event unclassified in that case.
 */
export function classifyEvent(packs: DomainPack[], input: ClassifierInput): Classification | null {
  let best: Classification | null = null;

  // Deterministic across packs: sort by domain id.
  for (const pack of [...packs].sort((a, b) => a.domain.localeCompare(b.domain))) {
    const candidates = objectCandidates(pack, input);
    if (candidates.length === 0) continue;
    const [object, objectScore] = candidates[0]!;
    const action = chooseAction(pack, object.id, input.event_type);

    // Confidence is evidence-based and capped; an action match adds a little,
    // never enough to reach certainty from weak object evidence alone.
    const confidence = Math.min(1, Number((objectScore + (action ? 0.1 : 0)).toFixed(4)));
    const candidate: Classification = {
      domain: pack.domain,
      object: object.id,
      ...(action ? { action: action.id } : {}),
      confidence,
    };
    if (!best || candidate.confidence > best.confidence) best = candidate;
  }

  return best;
}
