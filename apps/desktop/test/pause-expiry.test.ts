import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Pause for 15 minutes" must actually be 15 minutes. `paused_until` had
 * writers (pet menu, Mother, Onboarding) and ZERO readers, so the most
 * reachable control in the app set observation_paused: true forever — killing
 * the mother loop, Rust ingest, surfacing, and the pet in one click.
 */

let persisted: string | null = null;
const emitted: unknown[] = [];

vi.mock("../src/lib/bridge.js", () => ({
  isTauri: () => false,
  loadSettingsRaw: async () => persisted,
  saveSettingsRaw: async (json: string) => {
    persisted = json;
  },
  invokeCommand: async () => undefined,
  emitAppEvent: async (e: unknown) => {
    emitted.push(e);
  },
  onAppEvent: async () => () => {},
}));

const { DEFAULT_SETTINGS, expirePauseIfDue, pauseUntil, useSettings } = await import(
  "../src/state/settings.js"
);

beforeEach(() => {
  persisted = null;
  emitted.length = 0;
  useSettings.setState({ settings: DEFAULT_SETTINGS, hydrated: false });
});

describe("a timed pause expires", () => {
  it("resumes and persists once paused_until lapses", async () => {
    await useSettings.getState().update({
      observation_paused: true,
      paused_until: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(await expirePauseIfDue()).toBe(true);
    const s = useSettings.getState().settings;
    expect(s.observation_paused).toBe(false);
    expect(s.paused_until).toBeNull();
    // Persisted — Rust's ingest gate reads this file, so an in-memory resume
    // alone would leave observation dead on the native side.
    expect(JSON.parse(persisted!).observation_paused).toBe(false);
    expect(emitted.some((e) => (e as { type: string }).type === "observation_changed")).toBe(true);
  });

  it("a pause still inside its window stays paused", async () => {
    await useSettings.getState().update({ observation_paused: true, ...pauseUntil(15) });
    expect(await expirePauseIfDue()).toBe(false);
    expect(useSettings.getState().settings.observation_paused).toBe(true);
  });

  it("an UNTIMED pause is only ever resumed by the user", async () => {
    await useSettings.getState().update({ observation_paused: true, paused_until: null });
    expect(await expirePauseIfDue()).toBe(false);
    expect(useSettings.getState().settings.observation_paused).toBe(true);
  });

  it("hydrate itself expires a lapsed pause from disk", async () => {
    persisted = JSON.stringify({
      ...DEFAULT_SETTINGS,
      observation_paused: true,
      paused_until: new Date(Date.now() - 60_000).toISOString(),
    });
    await useSettings.getState().hydrate();
    expect(useSettings.getState().settings.observation_paused).toBe(false);
  });
});
