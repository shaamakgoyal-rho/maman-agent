import { create } from "zustand";
import { emitAppEvent } from "./bridge.js";
import { useRecommendations } from "./recommendations.js";
import { useSettings } from "../state/settings.js";

/**
 * THE PROACTIVE LOOP, OUT OF REACT.
 *
 * This used to be a `setInterval` inside `App.tsx`, which made the panel the
 * OWNER of proactivity: the loop's lifetime was a component's lifetime, and its
 * errors went into an empty `catch` where nobody could ever see them. A mother
 * agent that only notices things while a screen happens to be mounted is not
 * proactive.
 *
 * It now lives at module scope, booted once from the panel entry alongside the
 * agent service, and it records WHY a tick failed instead of swallowing it.
 * React reads `useMotherLoop` as a subscriber.
 *
 * SCOPE, STATED HONESTLY: this removes React's ownership of the timer, but the
 * loop still runs inside the panel process, because pattern scoring lives in
 * TypeScript (`@maman/pattern-engine`). Moving *detection* into the native
 * daemon so suggestions form with no webview alive is a separate change; the
 * native daemon already owns trigger evaluation and firing
 * (`src-tauri/src/trigger_service.rs`), which is the half that must survive a
 * closed panel today.
 */

/** One tick's outcome, kept for the Advanced/diagnostics view. */
export type LoopDiagnostic = {
  at: string;
  ok: boolean;
  detail: string;
};

type MotherLoopStore = {
  running: boolean;
  ticks: number;
  /** Newest first, bounded — a diagnostic log, not a growing leak. */
  diagnostics: LoopDiagnostic[];
};

export const useMotherLoop = create<MotherLoopStore>(() => ({
  running: false,
  ticks: 0,
  diagnostics: [],
}));

function record(ok: boolean, detail: string): void {
  useMotherLoop.setState((s) => ({
    ticks: s.ticks + 1,
    diagnostics: [{ at: new Date().toISOString(), ok, detail }, ...s.diagnostics].slice(0, 20),
  }));
}

const FIRST_TICK_MS = 4_000;
const INTERVAL_MS = 60_000;

let started = false;
let waving = false;
let timer: ReturnType<typeof setInterval> | null = null;
let firstTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;

/**
 * One pass: re-score observed activity, and if something NEW clears the
 * surfacing policy (daily budget, quiet hours, not paused), ask the pet to wave.
 */
export async function motherTick(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    if (useSettings.getState().settings.observation_paused) {
      record(true, "skipped: observation paused");
      return;
    }
    await emitAppEvent({ type: "simulate_pet_event", event: "THINKING_STARTED" });
    await useRecommendations.getState().refresh();
    await emitAppEvent({ type: "simulate_pet_event", event: "THINKING_FINISHED" });

    const state = useRecommendations.getState();
    const hasNew = state.items.some((i) => i.entry.status === "new");
    if (hasNew && !waving && (await state.maybeSurface())) {
      waving = true;
      await emitAppEvent({ type: "simulate_pet_event", event: "SUGGESTION_READY" });
      record(true, "surfaced a suggestion");
      return;
    }
    if (!hasNew && waving) {
      waving = false;
      await emitAppEvent({ type: "simulate_pet_event", event: "SUGGESTION_HANDLED" });
    }
    record(true, hasNew ? "suggestion held by policy" : "nothing new");
  } catch (error) {
    // NOT swallowed. A background failure the user can never see is a failure
    // that never gets fixed; this is the diagnostic the Advanced view shows.
    record(false, error instanceof Error ? error.message : "unknown tick failure");
  } finally {
    inFlight = false;
  }
}

/** Boots the loop once. Safe to call again — later calls are no-ops. */
export function bootMotherLoop(): void {
  if (started) return;
  started = true;
  useMotherLoop.setState({ running: true });
  firstTimer = setTimeout(() => void motherTick(), FIRST_TICK_MS);
  timer = setInterval(() => void motherTick(), INTERVAL_MS);
}

/** Test seam: stop the loop and forget it ever ran. */
export function __resetMotherLoopForTests(): void {
  if (firstTimer) clearTimeout(firstTimer);
  if (timer) clearInterval(timer);
  firstTimer = null;
  timer = null;
  started = false;
  waving = false;
  inFlight = false;
  useMotherLoop.setState({ running: false, ticks: 0, diagnostics: [] });
}
