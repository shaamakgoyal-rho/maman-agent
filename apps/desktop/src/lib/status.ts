/**
 * The status bar's brain: turns observation state + the latest pipeline beat
 * into one honest subtitle line and a dot color.
 *
 * The dot is a REAL health indicator, never decoration: green only when the
 * observer is actually observing and not paused. Every beat names the exact
 * workflow it is about — the same title the card and the agent carry — so
 * "what is Maman doing right now?" is answerable at a glance while working.
 *
 * Pure and unit-tested; the statusbar window is a thin renderer over this.
 */

/** A pipeline moment worth showing the worker, broadcast over app events. */
export type StatusBeat =
  | { kind: "idle" }
  | { kind: "watching"; title: string; detail: string }
  | { kind: "suggested"; title: string }
  | { kind: "creating_agent"; title: string }
  | { kind: "agent_ready"; title: string }
  | { kind: "agent_failed"; title: string; message: string }
  | { kind: "running"; title: string; phase: "reading" | "preparing" | "applying" }
  | { kind: "approval_needed"; title: string }
  | { kind: "run_done"; title: string; summary: string }
  | { kind: "run_failed"; title: string };

/** What the bar can know about observation health. */
export type ObservationHealth = {
  /** observer_status command value: disabled|starting|observing|permission_required|failed */
  observer: string;
  paused: boolean;
  /** store_status command value: ok|keychain_access_required|failed (absent in web preview). */
  store?: string;
};

export type DotColor = "green" | "amber" | "gray" | "red";

export type StatusLine = {
  dot: DotColor;
  text: string;
  /** True for moments that should hold the bar briefly (creation, approvals). */
  sticky: boolean;
};

/** Store states that freeze every surface (timeline, ingest, weekly stats). */
const STORE_TEXT: Record<string, string> = {
  keychain_access_required: "Maman needs keychain access — relaunch and click Always Allow",
  failed: "Maman's local store is unavailable",
};

export function dotFor(health: ObservationHealth): DotColor {
  // A blocked store outranks everything — even paused: nothing can be
  // recorded or shown until the user re-grants keychain access.
  if (health.store && STORE_TEXT[health.store]) return "red";
  if (health.paused) return "gray";
  switch (health.observer) {
    case "observing":
      return "green";
    case "starting":
      return "amber";
    case "permission_required":
    case "failed":
      return "red";
    default:
      return "gray"; // disabled / unknown: never pretend to observe
  }
}

const DOT_TEXT: Record<DotColor, string> = {
  green: "Maman is observing",
  amber: "Maman is starting up",
  gray: "Observation is paused",
  red: "Maman needs attention",
};

export function statusLine(beat: StatusBeat, health: ObservationHealth): StatusLine {
  const dot = dotFor(health);

  // A blocked store names the exact fix — a generic "needs attention" would
  // hide that the user has one specific action to take.
  const storeText = health.store ? STORE_TEXT[health.store] : undefined;
  if (storeText) {
    return { dot: "red", text: storeText, sticky: false };
  }

  // A broken/paused observer outranks pipeline beats: the bar must never say
  // "watching X" while nothing is actually being observed.
  if (dot === "red" || dot === "gray") {
    return { dot, text: DOT_TEXT[dot], sticky: false };
  }

  switch (beat.kind) {
    case "idle":
      return { dot, text: DOT_TEXT[dot], sticky: false };
    case "watching":
      return { dot, text: `Watching: ${beat.title} — ${beat.detail}`, sticky: false };
    case "suggested":
      return { dot, text: `Suggestion ready: ${beat.title}`, sticky: false };
    case "creating_agent":
      return { dot, text: `Creating agent: ${beat.title}…`, sticky: true };
    case "agent_ready":
      return { dot, text: `Agent drafted: ${beat.title}`, sticky: true };
    case "agent_failed":
      return { dot, text: `Couldn't draft ${beat.title}: ${beat.message}`, sticky: true };
    case "running": {
      const phase =
        beat.phase === "reading"
          ? "reading"
          : beat.phase === "preparing"
            ? "preparing the diff"
            : "applying approved changes";
      return { dot, text: `${beat.title}: ${phase}…`, sticky: true };
    }
    case "approval_needed":
      return { dot, text: `${beat.title}: waiting for your approval`, sticky: true };
    case "run_done":
      return { dot, text: `${beat.title}: ${beat.summary}`, sticky: true };
    case "run_failed":
      return { dot, text: `${beat.title}: run stopped safely`, sticky: true };
  }
}

/** How long sticky moments hold the bar before falling back (ms). */
export const STICKY_HOLD_MS = 8_000;
