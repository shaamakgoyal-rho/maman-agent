import type { PatternCandidate, PatternFeatureEvent, Recommendation } from "@maman/contracts";
import { patternSignature, runPatternEngine, toPatternFeature } from "@maman/pattern-engine";
import { create } from "zustand";
import { z } from "zod";
import { invokeCommand, isTauri } from "./bridge.js";
import { getMemoryRawEvents } from "./events.js";
import { canSurfaceSuggestion, snoozeUntil, type SnoozeOption } from "./suggestion-policy.js";
import { useSettings } from "../state/settings.js";

/**
 * Recommendation state: runs the deterministic pattern engine over the
 * privacy projection and applies the suggestion policy. Suggestion actions
 * (viewed/snoozed/dismissed/accepted/suppressed) persist locally.
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
    return invokeCommand<PatternFeatureEvent[]>("events_pattern_features", { limit: 10_000 });
  }
  return getMemoryRawEvents().map((e) => toPatternFeature(e));
}

export type RecommendationWithState = {
  recommendation: Recommendation;
  candidate: PatternCandidate;
  signature: string;
  entry: SuggestionEntry;
};

type RecommendationsStore = {
  state: SuggestionState;
  items: RecommendationWithState[];
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
      | { type: "wrong" },
  ) => Promise<void>;
  /** Whether the pet may wave right now (policy-gated); records surfacing. */
  maybeSurface: () => Promise<boolean>;
};

const DEFAULT_STATE: SuggestionState = suggestionStateSchema.parse({});

export const useRecommendations = create<RecommendationsStore>((set, get) => ({
  state: DEFAULT_STATE,
  items: [],
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

    const features = await fetchPatternFeatures();
    const result = runPatternEngine(features, {
      owner_user_id: OWNER_PLACEHOLDER,
      now: () => now,
      recently_dismissed_signatures: recentlyDismissed,
      suppressed_signatures: state.suppressed_signatures,
    });

    // Merge similar patterns (sequence similarity >= 0.9 handled by clustering;
    // identical signatures deduplicate here — one active recommendation per pattern).
    const seen = new Set<string>();
    const items: RecommendationWithState[] = [];
    for (const recommendation of result.recommendations) {
      const candidate = result.candidates.find(
        (c: { pattern_id: string }) => c.pattern_id === recommendation.pattern_id,
      );
      const signature = patternSignature(candidate?.canonical_sequence ?? []);
      if (seen.has(signature) || !candidate) continue;
      seen.add(signature);
      const entry: SuggestionEntry =
        state.entries[signature] ??
        ({
          status: "new",
          snoozed_until: null,
          dismissal_reason: null,
          dismissed_at: null,
          false_positive: false,
        } satisfies SuggestionEntry);
      items.push({ recommendation, candidate, signature, entry });
    }
    // Keep dismissed/accepted history entries visible in their filters even
    // when the engine no longer produces them (data deleted, cooldown, …).
    set({ state, items, hydrated: true });
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
    }
    const next = suggestionStateSchema.parse({
      ...state,
      entries,
      suppressed_signatures: suppressed,
    });
    await saveStateRaw(JSON.stringify(next));
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
