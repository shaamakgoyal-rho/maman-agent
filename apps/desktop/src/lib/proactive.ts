import {
  buildOutcome,
  evaluateDismissal,
  evaluateProactivity,
  SHIPPED_PACKS,
  type DismissalAction,
  type DomainPack,
  type FiscalCalendar,
  type ProactiveCard,
  type ProactiveDecision,
  type QuietPeriod,
  type SuggestionDecision,
  type SuggestionOutcome,
  type WorkflowSignal,
} from "@maman/domain-packs";
import { canSurfaceSuggestion, type SurfacingContext } from "./suggestion-policy.js";

/**
 * Wires Layer 5 proactivity into the desktop suggestion path.
 *
 * The ordering here is the safety property: the generic surfacing gate
 * (spec §12 — quiet hours, daily budget, private context, screen sharing…)
 * decides IF anything may surface, and proactivity only decides WHICH pack
 * workflow is due. A due card can never talk its way past the gate, which is
 * why `gateProactiveCard` runs `canSurfaceSuggestion` first and returns its
 * reason verbatim.
 */

/** `template_id` is "<pack_domain>/<workflow_id>" — split it, or get null. */
export function templateWorkflow(candidate: {
  template_id: string | null | undefined;
}): { pack_domain: string; workflow_id: string } | null {
  const id = candidate.template_id;
  if (!id) return null;
  const slash = id.indexOf("/");
  if (slash <= 0 || slash === id.length - 1) return null;
  return { pack_domain: id.slice(0, slash), workflow_id: id.slice(slash + 1) };
}

/** Maps a stored suggestion entry to the decision vocabulary Layer 5 reads. */
export function entryDecision(
  workflow_id: string,
  pattern_id: string,
  entry: {
    status: string;
    dismissal_reason: string | null;
    dismissed_at: string | null;
    snoozed_until: string | null;
  },
): SuggestionDecision | null {
  const at = entry.dismissed_at ?? entry.snoozed_until;
  const base = { workflow_id, pattern_id };
  switch (entry.status) {
    case "accepted":
      // No timestamp is recorded for acceptance today, so anchor it to the
      // dismissal clock if present; otherwise it still clears the ladder.
      return { ...base, action: "accepted", occurred_at: at ?? "1970-01-01T00:00:00.000Z" };
    case "snoozed":
      return at ? { ...base, action: "snoozed", occurred_at: at } : null;
    case "dismissed": {
      if (!at) return null;
      const action: DismissalAction =
        entry.dismissal_reason === "never_suggest"
          ? "never_suggest"
          : entry.dismissal_reason === "wrong_pattern"
            ? "wrong"
            : "dismissed";
      return { ...base, action, occurred_at: at };
    }
    default:
      return null;
  }
}

/** The most common weekday among a candidate's episodes, or undefined. */
export function modeWeekday(startedAt: string[]): number | undefined {
  const counts = new Map<number, number>();
  for (const iso of startedAt) {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) continue;
    const dow = new Date(t).getDay();
    counts.set(dow, (counts.get(dow) ?? 0) + 1);
  }
  let best: number | undefined;
  let bestN = 0;
  // Ascending key order keeps ties deterministic.
  for (const dow of [...counts.keys()].sort((a, b) => a - b)) {
    const n = counts.get(dow)!;
    if (n > bestN) {
      best = dow;
      bestN = n;
    }
  }
  return best;
}

/** One tracked pattern, reduced to what Layer 5 needs to know about it. */
export type ProactiveInput = {
  pattern_id: string;
  signature: string;
  template_id: string | null;
  /** Replay evidence, or null when it has not cleared the verification floor. */
  verified: { runs_matched: number; runs_tested: number } | null;
  /** Weekdays the episodes behind this pattern occurred on. */
  episode_weekdays: string[];
  entry: {
    status: string;
    dismissal_reason: string | null;
    dismissed_at: string | null;
    snoozed_until: string | null;
  };
  /** For date_driven workflows: an extracted date being watched. */
  watched?: { object: string; date: string; subject?: string } | undefined;
};

export type ProactiveItem = {
  card: ProactiveCard;
  /** The pattern this card would run, when one is already tracked. */
  pattern_id: string | null;
  signature: string | null;
};

/**
 * Collapses tracked patterns into one signal per pack workflow, then asks the
 * pack scheduler what is due. Evidence is only forwarded when replay
 * verification actually cleared the floor — an unverified card renders with
 * copy = null rather than an invented match rate.
 */
export function proactiveCards(input: {
  now: Date;
  calendar: FiscalCalendar;
  quiet_periods: QuietPeriod[];
  patterns: ProactiveInput[];
  packs?: DomainPack[];
}): { items: ProactiveItem[]; decisions: ProactiveDecision[] } {
  const packs = input.packs ?? (SHIPPED_PACKS as DomainPack[]);
  const byWorkflow = new Map<string, ProactiveInput[]>();
  for (const p of input.patterns) {
    const wf = templateWorkflow({ template_id: p.template_id });
    if (!wf) continue; // novel patterns are not pack workflows — nothing to schedule
    const list = byWorkflow.get(wf.workflow_id) ?? [];
    list.push(p);
    byWorkflow.set(wf.workflow_id, list);
  }

  const signals: WorkflowSignal[] = [];
  const representative = new Map<string, ProactiveInput>();
  for (const [workflow_id, group] of byWorkflow) {
    // Prefer the best-verified pattern as the one the card would run.
    const sorted = [...group].sort(
      (a, b) => (b.verified?.runs_tested ?? 0) - (a.verified?.runs_tested ?? 0),
    );
    const lead = sorted[0]!;
    representative.set(workflow_id, lead);
    const decisions = group
      .map((p) => entryDecision(workflow_id, p.pattern_id, p.entry))
      .filter((d): d is SuggestionDecision => d !== null);
    const watched = group.find((p) => p.watched)?.watched;
    signals.push({
      workflow_id,
      pattern_id: lead.pattern_id,
      runs_matched: lead.verified?.runs_matched,
      runs_tested: lead.verified?.runs_tested,
      observed_dow: modeWeekday(group.flatMap((p) => p.episode_weekdays)),
      watched_object: watched?.object,
      watched_date: watched?.date,
      subject: watched?.subject,
      decisions,
    });
  }

  const decisions = evaluateProactivity(packs, {
    now: input.now,
    calendar: input.calendar,
    quiet_periods: input.quiet_periods,
    signals,
  });

  const items: ProactiveItem[] = [];
  for (const d of decisions) {
    if (!d.fires) continue;
    const lead = representative.get(d.workflow_id);
    items.push({
      card: d.card,
      pattern_id: lead?.pattern_id ?? null,
      signature: lead?.signature ?? null,
    });
  }
  return { items, decisions };
}

export type ProactiveGate =
  | { surface: true }
  | { surface: false; reason: string; queued_until?: string | undefined };

/**
 * The generic gate decides first, always. A quiet period then QUEUES the card
 * (reporting when it releases) rather than dropping it.
 */
export function gateProactiveCard(card: ProactiveCard, ctx: SurfacingContext): ProactiveGate {
  const generic = canSurfaceSuggestion(ctx);
  if (!generic.allowed) return { surface: false, reason: generic.reason };
  if (card.queued_until) {
    return { surface: false, reason: "quiet_period", queued_until: card.queued_until };
  }
  return { surface: true };
}

/**
 * Whether a whole pack workflow family is currently suppressed — the pack
 * semantics for "never suggest this": saying never once must not leave Maman
 * asking about a sibling pattern of the same workflow tomorrow.
 */
export function familySuppressed(input: {
  now: Date;
  template_id: string | null;
  patterns: ProactiveInput[];
  packs?: DomainPack[];
}): boolean {
  const wf = templateWorkflow({ template_id: input.template_id });
  if (!wf) return false;
  const packs = input.packs ?? (SHIPPED_PACKS as DomainPack[]);
  const pack = packs.find((p) => p.domain === wf.pack_domain);
  if (!pack) return false;
  const decisions = input.patterns
    .filter((p) => templateWorkflow({ template_id: p.template_id })?.workflow_id === wf.workflow_id)
    .map((p) => entryDecision(wf.workflow_id, p.pattern_id, p.entry))
    .filter((d): d is SuggestionDecision => d !== null);
  const verdict = evaluateDismissal(pack, {
    workflow_id: wf.workflow_id,
    decisions,
    now: input.now,
  });
  // Only "never" hides a family outright; a backoff is a timing concern that the
  // scheduler already handles, and hiding the card entirely would lose history.
  return verdict.suppressed && verdict.reason !== "backoff";
}

/** Builds the outcome row for a user decision, ready for the Rust ledger. */
export function outcomeFor(input: {
  pattern_id: string;
  outcome: DismissalAction;
  reason?: string | null;
  now: Date;
  card?: ProactiveCard | undefined;
  triggered_at?: string | undefined;
}): SuggestionOutcome {
  return buildOutcome(input);
}
