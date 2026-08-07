import type { PatternCandidate, PatternFeatureEvent, Recommendation } from "@maman/contracts";
import { SHIPPED_PACKS } from "@maman/domain-packs";
import {
  effectiveEligibility,
  evaluateVerification,
  patternSignature,
  replayCandidateLeaveOneOut,
  representativeSequence,
  runPatternEngine,
  toPatternFeature,
  type ReplayReport,
  type SegmentedEpisode,
} from "@maman/pattern-engine";
import { patternGates, type FormingProgress } from "./forming.js";
import { create } from "zustand";
import { z } from "zod";
import { emitAppEvent, invokeCommand, isTauri } from "./bridge.js";
import { getMemoryRawEvents } from "./events.js";
import { canSurfaceSuggestion, snoozeUntil, type SnoozeOption } from "./suggestion-policy.js";
import {
  familySuppressed,
  nearestWatchedDates,
  outcomeFor,
  proactiveCards,
  type ProactiveInput,
  type ProactiveItem,
  type WatchedDateRow,
} from "./proactive.js";
import { useSettings } from "../state/settings.js";

/**
 * Recommendation state: runs the deterministic pattern engine over the
 * privacy projection, REPLAY-VERIFIES every candidate against the worker's own
 * recorded runs, and applies the suggestion policy. A pattern only becomes a
 * card once the compiled candidate has been tested against the last N runs and
 * cleared the verification gate — trust through proof, not confidence scores.
 * Suggestion actions (viewed/snoozed/dismissed/accepted/suppressed) persist
 * locally; traces and verification rows persist in the device store and never
 * leave the machine.
 */

const OWNER_PLACEHOLDER = "00000000-0000-7000-8000-000000000001";

const suggestionStateSchema = z
  .object({
    schema_version: z.literal(1).default(1),
    /** keyed by pattern signature */
    entries: z
      .record(
        z.string(),
        z
          .object({
            status: z.enum(["new", "viewed", "snoozed", "dismissed", "accepted"]),
            snoozed_until: z.string().nullable().default(null),
            dismissal_reason: z.string().nullable().default(null),
            dismissed_at: z.string().nullable().default(null),
            false_positive: z.boolean().default(false),
            /** Worker-edited workflow name shown on the card (null = derived). */
            custom_title: z.string().nullable().default(null),
          })
          .strict(),
      )
      .default({}),
    suppressed_signatures: z.array(z.string()).default([]),
    surfaced_dates: z.array(z.string()).default([]), // ISO dates of surfacings
  })
  .strict();

export type SuggestionState = z.infer<typeof suggestionStateSchema>;
export type SuggestionEntry = SuggestionState["entries"][string];

async function loadStateRaw(): Promise<string | null> {
  if (isTauri()) return invokeCommand<string | null>("suggestions_load");
  return localStorage.getItem("maman-suggestions");
}

async function saveStateRaw(json: string): Promise<void> {
  if (isTauri()) {
    await invokeCommand("suggestions_save", { json });
    return;
  }
  localStorage.setItem("maman-suggestions", json);
}

export async function fetchPatternFeatures(): Promise<PatternFeatureEvent[]> {
  if (isTauri()) {
    // 50k ≈ weeks of dense observation. If the store holds more, the Rust side
    // keeps the NEWEST 50k (ascending), so current behaviour is never the part
    // that falls off — the first live store to cross 10k proved the old
    // oldest-first cut silently hid the user's most recent work from the engine.
    return invokeCommand<PatternFeatureEvent[]>("events_pattern_features", { limit: 50_000 });
  }
  return getMemoryRawEvents().map((e) => toPatternFeature(e));
}

export type RecommendationWithState = {
  recommendation: Recommendation;
  candidate: PatternCandidate;
  signature: string;
  entry: SuggestionEntry;
  /** Replay-verification report — the card's "tested N, matched M" numbers. */
  verification: ReplayReport;
};

/** A pattern still forming — what's tracked + how close it is to a suggestion. */
export type FormingItem = {
  signature: string;
  candidate: PatternCandidate;
  title: string;
  summary: string;
  /** Redacted, human-readable steps Maman has observed. */
  steps: string[];
  progress: FormingProgress;
  verification: ReplayReport | null;
};

type RecommendationsStore = {
  state: SuggestionState;
  items: RecommendationWithState[];
  /** In-progress patterns not yet surfaceable, ranked closest-first. */
  forming: FormingItem[];
  /** Layer 5: pack workflows the calendar says are due (or queued). */
  proactive: ProactiveItem[];
  hydrated: boolean;
  refresh: () => Promise<void>;
  act: (
    signature: string,
    action:
      | { type: "viewed" }
      | { type: "accepted" }
      | { type: "snoozed"; option: SnoozeOption }
      | { type: "dismissed"; reason: string }
      | { type: "never_suggest" }
      | { type: "wrong" }
      | { type: "renamed"; title: string },
  ) => Promise<void>;
  /** Whether the pet may wave right now (policy-gated); records surfacing. */
  maybeSurface: () => Promise<boolean>;
};

const DEFAULT_STATE: SuggestionState = suggestionStateSchema.parse({});

/**
 * The closed reason vocabulary the outcome ledger accepts. A dismissal reason
 * that is not on this list becomes "other" rather than being passed through —
 * the ledger must never carry free text.
 */
const LEDGER_REASONS: ReadonlySet<string> = new Set([
  "not_useful",
  "wrong_pattern",
  "too_risky",
  "not_now",
  "never_suggest",
  "other",
]);

export const useRecommendations = create<RecommendationsStore>((set, get) => ({
  state: DEFAULT_STATE,
  items: [],
  forming: [],
  proactive: [],
  hydrated: false,

  refresh: async () => {
    let state = DEFAULT_STATE;
    try {
      const raw = await loadStateRaw();
      if (raw) {
        const parsed = suggestionStateSchema.safeParse(JSON.parse(raw));
        if (parsed.success) state = parsed.data;
      }
    } catch {
      // fall through to defaults
    }

    const now = new Date();
    const cooldownMs = 14 * 86_400_000;
    const recentlyDismissed = Object.entries(state.entries)
      .filter(
        ([, e]) =>
          e.status === "dismissed" &&
          e.dismissed_at &&
          now.getTime() - Date.parse(e.dismissed_at) < cooldownMs,
      )
      .map(([sig]) => sig);

    const settings = useSettings.getState().settings;
    // Detection tuning from settings: only volume/recency/value bars — the
    // engine clamps them and never exposes the safety bars (similarity,
    // feasibility, risk). The Forming UI shows these same effective values.
    const effectiveBars = {
      eligibility: effectiveEligibility({
        min_occurrences: settings.detect_min_occurrences,
        min_distinct_days: settings.detect_min_distinct_days,
        min_projected_minutes_weekly: settings.detect_min_projected_minutes_weekly,
      }),
      opportunity_threshold: settings.detect_opportunity_threshold,
    };

    const features = await fetchPatternFeatures();
    const result = runPatternEngine(features, {
      owner_user_id: OWNER_PLACEHOLDER,
      now: () => now,
      recently_dismissed_signatures: recentlyDismissed,
      suppressed_signatures: state.suppressed_signatures,
      eligibility: effectiveBars.eligibility,
      opportunity_threshold: effectiveBars.opportunity_threshold,
      segmentation: {
        event_gap_boundary_ms: settings.detect_event_gap_boundary_s * 1000,
        split_on_sequence_restart: settings.detect_split_on_sequence_restart,
      },
      // Template-primed detection (L2): the same compiled packs the Rust core
      // classifies with at ingest.
      packs: SHIPPED_PACKS,
    });

    // ---- replay verification (client-side; traces never leave the device) ----
    const replayThresholds = {
      min_runs: settings.verify_min_runs,
      min_match_pct: settings.verify_min_match_pct,
    };
    const episodeById = new Map<string, SegmentedEpisode>(
      result.episodes.map((e) => [e.episode_id, e]),
    );
    /**
     * Replays the candidate against its recorded runs using INDEPENDENT
     * validation: each run is held out and checked against a sequence derived
     * from the others.
     *
     * The previous call replayed `candidate.canonical_sequence` — the medoid of
     * these very episodes — against those same episodes, so a perfect score was
     * close to a tautology. Worse, when the tokens carried no semantic_type or
     * object_type (every token the live AX observer produces), the comparison
     * had zero executable steps on both sides and the old replay returned
     * "match" anyway: a real device reported "matched 21 of 21" and displayed a
     * verified badge on 21 comparisons of nothing.
     */
    const verify = (candidate: PatternCandidate): ReplayReport => {
      const traces = candidate.episode_ids
        .map((id) => episodeById.get(id))
        .filter((e): e is SegmentedEpisode => Boolean(e))
        .map((e) => ({
          episode_id: e.episode_id,
          started_at: e.started_at,
          tokens: e.canonical_tokens,
        }));
      return replayCandidateLeaveOneOut(
        traces,
        (training) => representativeSequence(training.map((t) => ({ canonical_tokens: t.tokens }))),
        settings.verify_window,
      );
    };
    /**
     * The badge gate now lives in the engine (`evaluateVerification`) so the
     * zero-step, self-referential, and unresolved-requirement refusals cannot
     * be re-implemented differently here. `reason` is carried to the card.
     */
    const gateOutcome = (r: ReplayReport) => evaluateVerification(r, replayThresholds);
    const passesGate = (r: ReplayReport): boolean => gateOutcome(r).verified;

    /** Best-effort persistence: candidates + traces + verification land in the
     * device store so every card number traces to a real pattern_candidates
     * row. Web preview (no Tauri) simply skips persistence. */
    const persistVerification = async (
      candidate: PatternCandidate,
      signature: string,
      report: ReplayReport,
    ): Promise<void> => {
      if (!isTauri()) return;
      try {
        await invokeCommand("patterns_upsert", { candidates: [candidate] });
        const traces = candidate.episode_ids
          .map((id) => episodeById.get(id))
          .filter((e): e is SegmentedEpisode => Boolean(e))
          .map((e) => ({
            episode_id: e.episode_id,
            pattern_signature: signature,
            started_at: e.started_at,
            tokens: e.canonical_tokens,
          }));
        if (traces.length > 0) await invokeCommand("traces_save", { traces });
        await invokeCommand("pattern_verification_save", {
          patternId: candidate.pattern_id,
          runsTested: report.runs_tested,
          runsMatched: report.runs_matched,
          detail: report.results,
        });
      } catch {
        // Persistence is auditability, not correctness — never block the UI.
      }
    };

    // Merge similar patterns (sequence similarity >= 0.9 handled by clustering;
    // identical signatures deduplicate here — one active recommendation per pattern).
    const seen = new Set<string>();
    const items: RecommendationWithState[] = [];
    const formingSeen = new Set<string>();
    const forming: FormingItem[] = [];

    for (const recommendation of result.recommendations) {
      const candidate = result.candidates.find(
        (c: { pattern_id: string }) => c.pattern_id === recommendation.pattern_id,
      );
      const signature = patternSignature(candidate?.canonical_sequence ?? []);
      if (seen.has(signature) || !candidate) continue;
      seen.add(signature);
      const verification = verify(candidate);
      await persistVerification(candidate, signature, verification);

      const entry: SuggestionEntry =
        state.entries[signature] ??
        ({
          status: "new",
          snoozed_until: null,
          dismissal_reason: null,
          dismissed_at: null,
          false_positive: false,
          custom_title: null,
        } satisfies SuggestionEntry);

      if (recommendation.template) {
        // Template match: the engine already applied min_reps_with_template and
        // the safety bars. The card makes the TEMPLATE claim ("matches a known
        // workflow, seen N x"); replay numbers appear only once runs_tested
        // clears the verify gate — at small N the verifier is self-referential
        // and a 2/2 score would be noise dressed as proof.
        items.push({ recommendation, candidate, signature, entry, verification });
      } else if (passesGate(verification)) {
        // Proven: this becomes the card.
        items.push({ recommendation, candidate, signature, entry, verification });
      } else if (entry.status !== "dismissed" && entry.status !== "accepted") {
        // Eligible but not yet proven: stays visibly forming with the score.
        formingSeen.add(signature);
        forming.push({
          signature,
          candidate,
          title: recommendation.title,
          summary: recommendation.summary,
          steps: recommendation.evidence.redacted_steps.map((s) => `${s.action} · ${s.app}`),
          progress: patternGates(
            candidate,
            { ...verification, ...replayThresholds },
            effectiveBars,
          ),
          verification,
        });
      }
    }

    // Forming: patterns Maman is watching that haven't crossed every bar yet.
    // Ranked closest-first so the user sees what's about to surface. Deduped by
    // signature (like `items`) so two clusters with the same canonical sequence
    // never collide on their React key or entry lookup.
    for (const w of result.watching) {
      const signature = patternSignature(w.candidate.canonical_sequence);
      if (formingSeen.has(signature) || seen.has(signature)) continue;
      const e = state.entries[signature];
      // Hide ones the user has explicitly waved off (dismissed/accepted).
      if (e && (e.status === "dismissed" || e.status === "accepted")) continue;
      formingSeen.add(signature);
      const verification = verify(w.candidate);
      forming.push({
        signature,
        candidate: w.candidate,
        title: w.naming.title,
        summary: w.naming.summary,
        steps: w.naming.redacted_steps.map((s) => `${s.action} · ${s.app}`),
        progress: patternGates(
          w.candidate,
          { ...verification, ...replayThresholds },
          effectiveBars,
        ),
        verification,
      });
    }
    forming.sort((a, b) => b.progress.ratio - a.progress.ratio);

    // ---- Layer 5: pack-tuned proactivity ------------------------------------
    // Reduce every tracked pattern to what the scheduler needs. Replay evidence
    // is forwarded ONLY once it clears the verification floor: below that the
    // numbers are self-referential, and a pack copy line that claims "matched
    // 2/2" would be noise dressed as proof.
    const weekdaysOf = (candidate: PatternCandidate): string[] =>
      candidate.episode_ids
        .map((id) => episodeById.get(id))
        .filter((e): e is SegmentedEpisode => Boolean(e))
        .map((e) => e.started_at);

    const proactiveInputs: ProactiveInput[] = [...items, ...forming].map((entry) => {
      const verification = entry.verification;
      const verified =
        verification && verification.runs_tested >= replayThresholds.min_runs
          ? { runs_matched: verification.runs_matched, runs_tested: verification.runs_tested }
          : null;
      return {
        pattern_id: entry.candidate.pattern_id,
        signature: entry.signature,
        template_id: entry.candidate.template_id ?? null,
        verified,
        episode_weekdays: weekdaysOf(entry.candidate),
        entry:
          "entry" in entry
            ? entry.entry
            : { status: "new", dismissal_reason: null, dismissed_at: null, snoozed_until: null },
      };
    });

    // Pack semantics for "never suggest": suppress the whole workflow FAMILY,
    // not just the pattern instance the user happened to be looking at.
    const hiddenByFamily = (candidate: PatternCandidate): boolean =>
      familySuppressed({
        now,
        template_id: candidate.template_id ?? null,
        patterns: proactiveInputs,
      });
    const visibleItems = items.filter(
      (i) => i.entry.status === "dismissed" || !hiddenByFamily(i.candidate),
    );
    const visibleForming = forming.filter((f) => !hiddenByFamily(f.candidate));

    // Dates the observer read from labels (renewal term ends and the like).
    // Local-only read: this never touches the feature projection, and a failure
    // to fetch simply means no date-driven card, never a fabricated one.
    let watchedRows: WatchedDateRow[] = [];
    if (isTauri()) {
      try {
        watchedRows = await invokeCommand<WatchedDateRow[]>("watched_dates", { limit: 2000 });
      } catch {
        watchedRows = [];
      }
    } else {
      // Web preview: derive the same rows from in-memory events, applying the
      // SAME filter as the Rust query (classified events only) so the preview
      // and the device cannot tell different stories.
      watchedRows = getMemoryRawEvents()
        .flatMap((e) =>
          (e.target.label_dates ?? []).map((d) => ({
            occurred_at: e.occurred_at,
            pack_domain: e.classification?.domain ?? null,
            domain_object: e.classification?.object ?? null,
            date: d.date,
            confidence: d.confidence,
          })),
        )
        .filter((r) => r.pack_domain !== null && r.domain_object !== null);
    }

    const { items: proactive } = proactiveCards({
      now,
      calendar: {
        fiscal_year_start_month: settings.fiscal_year_start_month,
        close_start_day: settings.fiscal_close_start_day,
      },
      quiet_periods: settings.quiet_periods,
      patterns: proactiveInputs,
      watched_dates: nearestWatchedDates(watchedRows, now),
    });

    // Status bar: the current top of the funnel, named after the workflow.
    const freshItem = visibleItems.find((i) => i.entry.status === "new");
    if (freshItem) {
      await emitAppEvent({
        type: "status_beat",
        beat: {
          kind: "suggested",
          title: freshItem.entry.custom_title ?? freshItem.recommendation.title,
        },
      });
    } else if (proactive.length > 0) {
      // A pack workflow the calendar says is due — the pet has something to
      // offer even though no new pattern crossed the bar today.
      await emitAppEvent({
        type: "status_beat",
        beat: { kind: "suggested", title: proactive[0]!.card.workflow_name },
      });
    } else if (visibleForming.length > 0) {
      const top = visibleForming[0]!;
      await emitAppEvent({
        type: "status_beat",
        beat: {
          kind: "watching",
          title: top.title,
          detail: `${top.progress.metCount} of ${top.progress.total} checks`,
        },
      });
    } else {
      await emitAppEvent({ type: "status_beat", beat: { kind: "idle" } });
    }

    // Keep dismissed/accepted history entries visible in their filters even
    // when the engine no longer produces them (data deleted, cooldown, …).
    set({ state, items: visibleItems, forming: visibleForming, proactive, hydrated: true });
  },

  act: async (signature, action) => {
    const { state } = get();
    const entries = { ...state.entries };
    const current: SuggestionEntry = entries[signature] ?? {
      status: "new",
      snoozed_until: null,
      dismissal_reason: null,
      dismissed_at: null,
      false_positive: false,
      custom_title: null,
    };
    let suppressed = state.suppressed_signatures;
    const now = new Date();
    switch (action.type) {
      case "viewed":
        entries[signature] = {
          ...current,
          status: current.status === "new" ? "viewed" : current.status,
        };
        break;
      case "accepted":
        entries[signature] = { ...current, status: "accepted" };
        break;
      case "snoozed":
        entries[signature] = {
          ...current,
          status: "snoozed",
          snoozed_until: snoozeUntil(action.option, now),
        };
        break;
      case "dismissed":
        entries[signature] = {
          ...current,
          status: "dismissed",
          dismissal_reason: action.reason,
          dismissed_at: now.toISOString(),
        };
        break;
      case "never_suggest":
        entries[signature] = {
          ...current,
          status: "dismissed",
          dismissal_reason: "never_suggest",
          dismissed_at: now.toISOString(),
        };
        suppressed = [...new Set([...suppressed, signature])];
        break;
      case "wrong":
        entries[signature] = {
          ...current,
          status: "dismissed",
          dismissal_reason: "wrong_pattern",
          dismissed_at: now.toISOString(),
          false_positive: true,
        };
        break;
      case "renamed":
        entries[signature] = {
          ...current,
          custom_title: action.title.trim() ? action.title.trim().slice(0, 120) : null,
        };
        break;
    }
    const next = suggestionStateSchema.parse({
      ...state,
      entries,
      suppressed_signatures: suppressed,
    });
    await saveStateRaw(JSON.stringify(next));
    // Append material decisions to the local suggestion_history ledger
    // (best-effort; the JSON state above is authoritative for the UI).
    if (isTauri() && action.type !== "viewed" && action.type !== "renamed") {
      const item =
        get().items.find((i) => i.signature === signature) ??
        get().forming.find((f) => f.signature === signature);
      const patternId = item?.candidate.pattern_id;
      if (patternId) {
        const reason =
          action.type === "dismissed"
            ? action.reason
            : action.type === "never_suggest"
              ? "never_suggest"
              : action.type === "wrong"
                ? "wrong_pattern"
                : null;
        void invokeCommand("suggestion_history_log", {
          patternId,
          action: action.type,
          reason,
        }).catch(() => {});

        // Layer 5: the same decision, plus the context it was made in, into the
        // local outcome ledger. Closed vocabularies only — the Rust store
        // rejects anything that could carry content.
        const card = get().proactive.find((p) => p.signature === signature)?.card;
        const outcome = outcomeFor({
          pattern_id: patternId,
          outcome:
            action.type === "never_suggest"
              ? "never_suggest"
              : action.type === "wrong"
                ? "wrong"
                : action.type === "snoozed"
                  ? "snoozed"
                  : action.type === "accepted"
                    ? "accepted"
                    : "dismissed",
          reason: LEDGER_REASONS.has(reason ?? "")
            ? reason
            : action.type === "dismissed"
              ? "other"
              : null,
          now,
          card,
          triggered_at: card ? `${card.due_date}T00:00:00.000Z` : undefined,
        });
        void invokeCommand("suggestion_outcome_log", {
          patternId: outcome.pattern_id,
          workflowId: outcome.workflow_id,
          packDomain: outcome.pack_domain,
          cadence: outcome.cadence,
          surface: outcome.surface,
          outcome: outcome.outcome,
          reason: outcome.reason,
          localDow: outcome.local_dow,
          localHour: outcome.local_hour,
          cadencePhase: outcome.cadence_phase,
          secondsSinceTrigger: outcome.seconds_since_trigger,
        }).catch(() => {});
      }
    }
    set({ state: next });
    await get().refresh();
  },

  maybeSurface: async () => {
    const { state, items } = get();
    const settings = useSettings.getState().settings;
    const fresh = items.filter((i) => i.entry.status === "new");
    if (fresh.length === 0) return false;
    const today = new Date().toISOString().slice(0, 10);
    const surfacedToday = state.surfaced_dates.filter((d) => d === today).length;
    const decision = canSurfaceSuggestion({
      now: new Date(),
      observation_paused: settings.observation_paused,
      private_context: false,
      fullscreen_or_presenting: false,
      screen_sharing: false,
      surfaced_today: surfacedToday,
      daily_budget: settings.suggestion_budget_daily,
      quiet_hours_start: settings.quiet_hours_start,
      quiet_hours_end: settings.quiet_hours_end,
      attention_required: false,
      idle_seconds: 60,
      just_completed_workflow: true,
      snoozed_until: fresh[0]!.entry.snoozed_until,
    });
    if (!decision.allowed) return false;
    const next = suggestionStateSchema.parse({
      ...state,
      surfaced_dates: [...state.surfaced_dates, today].slice(-50),
    });
    await saveStateRaw(JSON.stringify(next));
    set({ state: next });
    return true;
  },
}));
