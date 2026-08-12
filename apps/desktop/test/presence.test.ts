/**
 * @vitest-environment jsdom
 *
 * PRESENCE IS ABOUT THE HUMAN, NOT ABOUT MAMAN'S WINDOW.
 *
 * The gate this feeds refuses consequential browser writes when nobody is at
 * the machine. It used to read the panel webview's `visibilityState`, which
 * inverted the question: a user typing in Chrome (panel hidden) was "absent",
 * and a user at lunch (panel open) was "present". These tests pin the corrected
 * signal — the system idle clock — and the fail-closed behaviour around it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tauri = true;
let idleAnswer: number | Error = 0;
const invoked: string[] = [];

vi.mock("../src/lib/bridge.js", () => ({
  isTauri: () => tauri,
  invokeCommand: async (cmd: string) => {
    invoked.push(cmd);
    if (cmd === "user_idle_seconds") {
      if (idleAnswer instanceof Error) throw idleAnswer;
      return idleAnswer;
    }
    return undefined;
  },
}));

const { userIsPresent, refreshPresence, __resetPresenceForTests, PRESENT_WITHIN_SECONDS } =
  await import("../src/lib/presence.js");

beforeEach(() => {
  tauri = true;
  idleAnswer = 0;
  invoked.length = 0;
  __resetPresenceForTests();
});
afterEach(() => __resetPresenceForTests());

describe("presence reads the system idle clock", () => {
  it("a user who just touched the machine is PRESENT even with the panel hidden", async () => {
    // The exact case the old signal got wrong: the panel is not visible, but
    // the person is right there working in Chrome.
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    idleAnswer = 3;
    await refreshPresence();
    expect(userIsPresent()).toBe(true);
    expect(invoked).toContain("user_idle_seconds");
  });

  it("a user at lunch is ABSENT even with the panel wide open", async () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    idleAnswer = 15 * 60;
    await refreshPresence();
    expect(userIsPresent()).toBe(false);
  });

  it("the boundary is the documented threshold, not a hidden constant", async () => {
    idleAnswer = PRESENT_WITHIN_SECONDS;
    await refreshPresence();
    expect(userIsPresent()).toBe(true);
    idleAnswer = PRESENT_WITHIN_SECONDS + 1;
    await refreshPresence();
    expect(userIsPresent()).toBe(false);
  });
});

describe("an unanswered presence question fails closed", () => {
  it("no reading yet in the desktop app ⇒ absent, whatever the panel says", () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    // Nothing probed yet: the desktop app must not fall back to panel
    // visibility, which is the signal that caused the bug.
    expect(userIsPresent()).toBe(false);
  });

  it("a failed probe does not invent a reading", async () => {
    idleAnswer = new Error("command unavailable");
    await refreshPresence();
    expect(userIsPresent()).toBe(false);
  });

  it("outside the desktop app (preview/tests) a visible document is the only evidence", async () => {
    tauri = false;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    await refreshPresence(); // no-op without Tauri
    expect(userIsPresent()).toBe(true);
    expect(invoked).not.toContain("user_idle_seconds");

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    expect(userIsPresent()).toBe(false);
  });
});
