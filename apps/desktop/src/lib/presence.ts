import { invokeCommand, isTauri } from "./bridge.js";

/**
 * USER PRESENCE — the actuator's fail-closed gate for consequential writes.
 *
 * THE BUG THIS REPLACES. Presence used to mean `document.visibilityState` of
 * the PANEL webview. The panel is created hidden and hides (not closes) on
 * dismiss, so "present" actually meant "Maman's own window is in front" — the
 * opposite of what the gate is for:
 *
 *   - user typing in Chrome, panel hidden  → reported ABSENT (wrong: they are
 *     right there, watching the page being written)
 *   - user at lunch, panel left open       → reported PRESENT (wrong, and the
 *     dangerous direction)
 *
 * Every autonomous firing happens while the panel is hidden by definition, so
 * the old signal made click-free execution structurally impossible while ALSO
 * permitting writes with nobody at the machine.
 *
 * THE SIGNAL NOW is macOS' own idle clock (`user_idle_seconds` → CoreGraphics),
 * which answers the actual question: has this human touched the machine
 * recently? That reads a DURATION, never an input event — no key code, no
 * content, nothing to store (see the Rust command's note).
 *
 * SYNCHRONOUS BY CONTRACT. The pure actuator takes `userPresent: () => boolean`
 * and evaluates it at the instant of each write, so this cannot await. A
 * refresh loop keeps a cached reading warm and `userIsPresent()` reads the
 * cache; a reading older than `STALE_AFTER_MS` is not trusted.
 */

/** How long since the last input still counts as "somebody is here". */
export const PRESENT_WITHIN_SECONDS = 120;

/** A cached reading older than this is not evidence of anything. */
const STALE_AFTER_MS = 20_000;

/** How often the loop re-reads the idle clock. Cheap: one scalar syscall. */
const REFRESH_EVERY_MS = 5_000;

let idleSeconds: number | null = null;
let readAt = 0;
let loop: ReturnType<typeof setInterval> | null = null;

/**
 * Reads the system idle clock once and caches it. Safe to call anywhere; a
 * failure leaves the previous reading to go stale rather than inventing one.
 */
export async function refreshPresence(): Promise<void> {
  if (!isTauri()) return;
  try {
    const seconds = await invokeCommand<number>("user_idle_seconds");
    if (typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0) {
      idleSeconds = seconds;
      readAt = Date.now();
    }
  } catch {
    // Leave the cache alone: a probe that failed is not a presence claim.
  }
}

/**
 * Starts the refresh loop (idempotent). AWAITS the first reading so the cache
 * is warm before boot returns — otherwise a run in the first milliseconds
 * would fail closed on a question that was merely not asked yet. Module scope,
 * so it outlives every screen like the rest of the proactive machinery.
 */
export async function startPresenceTracking(): Promise<void> {
  if (loop !== null || !isTauri()) return;
  await refreshPresence();
  loop = setInterval(() => void refreshPresence(), REFRESH_EVERY_MS);
}

/** Test seam: stop the loop and forget the cached reading. */
export function __resetPresenceForTests(): void {
  if (loop !== null) clearInterval(loop);
  loop = null;
  idleSeconds = null;
  readAt = 0;
}

/**
 * Is somebody at the machine right now?
 *
 * Prefers the system idle clock. Falls back to the panel's visibility ONLY
 * where no such clock exists (the browser preview and tests) — never as a
 * silent substitute in the desktop app, where a stale reading means the
 * question is unanswered and a consequential write must not proceed.
 */
export function userIsPresent(): boolean {
  const fresh = idleSeconds !== null && Date.now() - readAt < STALE_AFTER_MS;
  if (fresh) return idleSeconds! <= PRESENT_WITHIN_SECONDS;
  // In the desktop app the clock is the only acceptable answer: fail closed.
  if (isTauri()) return false;
  // Web preview / tests: a visible document is the only evidence available.
  if (typeof document === "undefined") return false;
  return document.visibilityState === "visible";
}
