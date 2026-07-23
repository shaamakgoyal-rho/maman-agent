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
    reduced_motion: z.enum(["system", "on", "off"]).default("system"),
    global_shortcut: z.string().default("Control+Alt+P"),
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
