import { describe, expect, it } from "vitest";
import { isUserInitiatedMove } from "../src/statusbar/StatusBar.js";

/**
 * The bar is draggable, and the core also moves it (startup anchor, docking to
 * the monitored window). Both paths fire the same Moved event, so telling them
 * apart is the whole correctness question here.
 *
 * Found on-device: without this distinction the FIRST automatic placement was
 * recorded as a user drag, which turned "dock to the window I'm working in" off
 * before the user had touched anything.
 */
describe("distinguishing a drag from automatic placement", () => {
  it("counts a move as the user's only when they pressed on the bar", () => {
    expect(isUserInitiatedMove(true)).toBe(true);
  });

  it("ignores a move nobody asked for — the startup anchor and docking", () => {
    expect(isUserInitiatedMove(false)).toBe(false);
  });
});
