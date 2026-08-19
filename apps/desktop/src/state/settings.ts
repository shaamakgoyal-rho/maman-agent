import { create } from "zustand";
import { z } from "zod";
import { emitAppEvent, loadSettingsRaw, saveSettingsRaw } from "../lib/bridge.js";

/**
 * Local desktop settings. Persisted through the Rust core (JSON file at M2;
 * migrates into the encrypted SQLite store at M3). Web preview persists to
 * localStorage. Observation defaults OFF until onboarding consent completes.
 */

export const localSettingsSchema = z
  .object({
    schema_version: z.literal(1).default(1),
    onboarding_complete: z.boolean().default(false),
    comprehension_confirmed: z.boolean().default(false),
    observation_paused: z.boolean().default(true),
    paused_until: z.string().nullable().default(null),
    allowlist_domains: z.array(z.string()).default([]),
    allowlist_bundles: z.array(z.string()).default([]),
    /**
     * Origins a supervised browser run may WRITE to, stated in full
     * (scheme + host), e.g. an org's own Salesforce host.
     *
     * Deliberately separate from `allowlist_domains`, which only grants
     * observation: being watched and being typed into are different permissions,
     * and this one is compared exactly rather than by domain suffix. Empty by
     * default, and while it is empty a browser-lane plan is refused rather than
     * sent — so actuation is off until the user names a site.
     */
    browser_actuation_origins: z.array(z.string()).default([]),
    /**
     * Whether Teach Mode sessions may be started at all.
     *
     * OFF by default, and the default matters more here than anywhere else in this
     * file: this is the only setting whose "on" state causes pictures of the user's
     * screen to leave the machine. Enabling it does not start a session — it only
     * makes starting one possible.
     */
    teach_mode_enabled: z.boolean().default(false),
    /**
     * Vision model alias used to PRICE a Teach Mode session in the panel.
     *
     * The Rust core reads the real model from `ANTHROPIC_VISION_MODEL`; this is the
     * same name so the quote matches what will actually run. Empty means nothing is
     * configured, and the panel says so rather than quoting a number.
     */
    vision_model_alias: z.string().default(""),
    /**
     * Explicit opt-in to observe EVERY app (except always-off / private ones),
     * instead of only the apps in allowlist_bundles. Hard-deny, user-private,
     * and secure-field boundaries still apply, so sensitive contexts are never
     * observed. Default off (privacy-first).
     */
    observe_all_apps: z.boolean().default(false),
    private_apps: z.array(z.string()).default([]),
    suggestion_budget_daily: z.number().int().min(0).max(10).default(2),
    quiet_hours_start: z.string().default("18:00"),
    quiet_hours_end: z.string().default("08:30"),
    // Fiscal calendar (Layer 5). A pack says `calendar: fiscal`; the company
    // says WHEN its periods land, so this is a setting, never pack content.
    fiscal_year_start_month: z.number().int().min(1).max(12).default(1),
    /** Day of month the monthly close opens (clamped to the month's length). */
    fiscal_close_start_day: z.number().int().min(1).max(31).default(1),
    /**
     * User-editable date ranges (audit weeks, board prep) during which proactive
     * cards QUEUE silently instead of interrupting. Nothing is dropped: each
     * card reports the date it will be released.
     */
    quiet_periods: z
      .array(
        z
          .object({
            start: z.string(),
            end: z.string(),
            label: z.string().max(60).optional(),
          })
          .strict(),
      )
      .default([]),
    reduced_motion: z.enum(["system", "on", "off"]).default("system"),
    /** The always-on-top subtitle bar showing what Maman is doing right now. */
    statusbar_enabled: z.boolean().default(true),
    /**
     * Whether the bar docks to the window being monitored. Dragging the bar turns
     * this OFF: a position you chose by hand must not be yanked back on the next
     * focus change. "Reset position" turns it on again.
     */
    statusbar_follow_window: z.boolean().default(true),
    /**
     * Let clicks pass through the bar to the window underneath. Mutually
     * exclusive with dragging — a click-through window never receives the mouse,
     * so it cannot be grabbed. Off by default so the bar can be moved.
     */
    statusbar_click_through: z.boolean().default(false),
    global_shortcut: z.string().default("Control+Alt+P"),
    // Replay-verification gate: a pattern becomes a suggestion card only after
    // the compiled candidate has been tested against the worker's own recorded
    // runs and cleared this bar. Tunable so the demo can adjust honestly.
    // Default 5, not 10: detection needs only detect_min_occurrences (3)
    // repetitions, so a 10-run floor parked every eligible pattern in Forming
    // for 7 MORE repetitions with no other route to a card. Five usable runs
    // still demands real independent evidence (leave-one-out needs ≥2) without
    // making the wait longer than the workflow's own detection.
    verify_min_runs: z.number().int().min(1).max(100).default(5),
    verify_min_match_pct: z.number().min(0).max(1).default(0.85),
    /** How many of the most recent recorded runs to replay against. */
    verify_window: z.number().int().min(1).max(100).default(21),
    // Detection tuning: each value maps 1:1 to a real pattern-engine bar and
    // the Forming UI always displays the EFFECTIVE values, so lowering a bar
    // is visible, never hidden. The safety bars (similarity, feasibility,
    // risk) are deliberately not settings — the engine refuses to tune them.
    detect_min_occurrences: z.number().int().min(2).max(20).default(3),
    detect_min_distinct_days: z.number().int().min(1).max(14).default(2),
    detect_min_projected_minutes_weekly: z.number().min(0).max(600).default(20),
    detect_opportunity_threshold: z.number().min(0).max(1).default(0.65),
    /** Idle gap (seconds) that closes an episode — lower to split quick reps. */
    detect_event_gap_boundary_s: z.number().int().min(30).max(3600).default(600),
    /** Split back-to-back repetitions when the workflow's first step recurs. */
    detect_split_on_sequence_restart: z.boolean().default(false),
    /** Approved supervised runs required before draft autonomy can be granted. */
    autonomy_min_approved_runs: z.number().int().min(1).max(50).default(5),
    // Maman server enrollment (display only — the device TOKEN never reaches the
    // webview; it lives in the OS keychain and is attached by the Rust core).
    server_enabled: z.boolean().default(false),
    // Stable per-device public id (UUID) for enrollment idempotency — generated
    // once on first enroll so re-enrolling reuses the same device row.
    server_device_public_id: z.string().nullable().default(null),
    server_device_id: z.string().nullable().default(null),
    server_token_expires_at: z.string().nullable().default(null),
    server_last_sync_at: z.string().nullable().default(null),
  })
  .strict();

export type LocalSettings = z.infer<typeof localSettingsSchema>;

export const DEFAULT_SETTINGS: LocalSettings = localSettingsSchema.parse({});

/** The detection-tuning knobs, as one patch (used by the Settings presets). */
export type DetectionTuning = Pick<
  LocalSettings,
  | "detect_min_occurrences"
  | "detect_min_distinct_days"
  | "detect_min_projected_minutes_weekly"
  | "detect_opportunity_threshold"
  | "detect_event_gap_boundary_s"
  | "detect_split_on_sequence_restart"
  | "verify_min_runs"
>;

export const DETECTION_PRODUCTION: DetectionTuning = {
  detect_min_occurrences: DEFAULT_SETTINGS.detect_min_occurrences,
  detect_min_distinct_days: DEFAULT_SETTINGS.detect_min_distinct_days,
  detect_min_projected_minutes_weekly: DEFAULT_SETTINGS.detect_min_projected_minutes_weekly,
  detect_opportunity_threshold: DEFAULT_SETTINGS.detect_opportunity_threshold,
  detect_event_gap_boundary_s: DEFAULT_SETTINGS.detect_event_gap_boundary_s,
  detect_split_on_sequence_restart: DEFAULT_SETTINGS.detect_split_on_sequence_restart,
  verify_min_runs: DEFAULT_SETTINGS.verify_min_runs,
};

/**
 * Live-demo preset: detect a workflow repeated ~4× in one sitting. Lowers only
 * volume/recency/value bars (never similarity, feasibility, or risk) and turns
 * on repetition splitting so back-to-back runs count separately.
 */
export const DETECTION_LIVE_DEMO: DetectionTuning = {
  detect_min_occurrences: 3,
  detect_min_distinct_days: 1,
  detect_min_projected_minutes_weekly: 3,
  detect_opportunity_threshold: 0.5,
  detect_event_gap_boundary_s: 90,
  detect_split_on_sequence_restart: true,
  verify_min_runs: 3,
};

/** True when any detection bar differs from the production default. */
export function detectionTuned(s: LocalSettings): boolean {
  return (Object.keys(DETECTION_PRODUCTION) as Array<keyof DetectionTuning>).some(
    (k) => s[k] !== DETECTION_PRODUCTION[k],
  );
}

/**
 * Desktop-app presets (macOS bundle ids) the AX observer can watch. Browser
 * bundles are included because most sales work is a browser app; the observer
 * sees the app + window shape, while the Chrome relay adds domain-level detail.
 * Nothing is pre-enabled — the user opts each app in (Privacy → Allowed apps).
 */
export const APP_PRESETS: Array<{ label: string; bundleId: string }> = [
  { label: "Google Chrome", bundleId: "com.google.Chrome" },
  { label: "Safari", bundleId: "com.apple.Safari" },
  { label: "Arc", bundleId: "company.thebrowser.Browser" },
  { label: "Microsoft Edge", bundleId: "com.microsoft.edgemac" },
  { label: "Slack", bundleId: "com.tinyspeck.slackmacgap" },
  { label: "Notion", bundleId: "notion.id" },
  { label: "Microsoft Outlook", bundleId: "com.microsoft.Outlook" },
  { label: "Apple Mail", bundleId: "com.apple.mail" },
];

/**
 * The browsers among APP_PRESETS. Allowing a SITE is meaningless to the AX
 * observer, which gates on the bundle id of the app the work happens in — so
 * consenting to sites has to imply consenting to the browsers they run in.
 */
export const BROWSER_BUNDLE_IDS = [
  "com.google.Chrome",
  "com.apple.Safari",
  "company.thebrowser.Browser",
  "com.microsoft.edgemac",
] as const;

/**
 * Which app bundles a set of allowed SITES implies, unioned with whatever the
 * user already allowed.
 *
 * THE BUG THIS EXISTS FOR: onboarding persisted `allowlist_domains` and never
 * `allowlist_bundles`, and the Swift observer drops every event whose bundle is
 * not allowlisted (an empty list matches nothing). So a user could complete the
 * whole consent flow, check Salesforce and Gmail, click "Finish and start
 * observing" — and Maman observed literally nothing, forever, while the home
 * screen said "Watching your work". Allowing zero sites still implies zero
 * bundles: "observe nothing" has to keep meaning nothing.
 */
export function bundlesForDomains(
  domains: readonly string[],
  existing: readonly string[] = [],
): string[] {
  if (domains.length === 0) return [...new Set(existing)];
  return [...new Set([...existing, ...BROWSER_BUNDLE_IDS])];
}

/** Domain/bundle presets offered (never pre-enabled) during onboarding. */
export const ALLOWLIST_PRESETS: Array<{ label: string; domain: string }> = [
  { label: "Salesforce", domain: "salesforce.com" },
  { label: "Google Sheets", domain: "docs.google.com" },
  { label: "Gmail", domain: "mail.google.com" },
  { label: "Google Calendar", domain: "calendar.google.com" },
  { label: "Slack (web)", domain: "app.slack.com" },
  { label: "LinkedIn", domain: "linkedin.com" },
  { label: "Apollo (enrichment)", domain: "app.apollo.io" },
  { label: "ZoomInfo (enrichment)", domain: "zoominfo.com" },
];

type SettingsStore = {
  settings: LocalSettings;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  update: (patch: Partial<LocalSettings>) => Promise<void>;
};

export const useSettings = create<SettingsStore>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  hydrated: false,
  hydrate: async () => {
    try {
      const raw = await loadSettingsRaw();
      if (raw) {
        const parsed = localSettingsSchema.safeParse(JSON.parse(raw));
        if (parsed.success) {
          set({ settings: parsed.data, hydrated: true });
          return;
        }
      }
    } catch {
      // fall through to defaults — never crash on corrupt settings
    }
    set({ settings: DEFAULT_SETTINGS, hydrated: true });
  },
  update: async (patch) => {
    const next = localSettingsSchema.parse({ ...get().settings, ...patch });
    set({ settings: next });
    await saveSettingsRaw(JSON.stringify(next));
    await emitAppEvent({ type: "settings_changed" });
  },
}));

/** Pause helpers (one-click reachable from the pet menu). */
export function pauseUntil(minutes: number | "tomorrow"): { paused_until: string } {
  const now = new Date();
  if (minutes === "tomorrow") {
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    tomorrow.setHours(8, 30, 0, 0);
    return { paused_until: tomorrow.toISOString() };
  }
  return { paused_until: new Date(now.getTime() + minutes * 60_000).toISOString() };
}
