import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Turning the subtitle bar off has to actually remove it.
 *
 * The bar is now switchable from the Home screen, next to what it narrates, as
 * well as from Settings. Two inlined copies of "record the preference, then move
 * the window" would drift, and the drift has a specific shape: a stored `false`
 * over a bar still sitting on top of the user's screen. One helper, one
 * behaviour, and the preference is only kept if the window obeyed.
 */

let tauri = true;
let commandFails = false;
const calls: Array<{ cmd: string; args: unknown }> = [];

vi.mock("../src/lib/bridge.js", () => ({
  isTauri: () => tauri,
  invokeCommand: async (cmd: string, args?: unknown) => {
    calls.push({ cmd, args });
    if (commandFails) throw new Error("the status bar window is gone");
    return undefined;
  },
  emitAppEvent: async () => undefined,
}));

const { setSubtitleBarVisible } = await import("../src/lib/statusbar.js");

beforeEach(() => {
  tauri = true;
  commandFails = false;
  calls.length = 0;
});

describe("hiding the bar", () => {
  it("records the preference AND moves the window", async () => {
    const patches: Array<{ statusbar_enabled: boolean }> = [];
    const result = await setSubtitleBarVisible(false, (p) => {
      patches.push(p);
    });

    expect(result.ok).toBe(true);
    expect(patches).toEqual([{ statusbar_enabled: false }]);
    expect(calls).toEqual([{ cmd: "statusbar_set_visible", args: { visible: false } }]);
  });

  it("ROLLS THE PREFERENCE BACK when the window will not obey", async () => {
    // A stored `false` over a visible bar is the setting failing in the most
    // visible way possible. Better to report that it did not work than to claim
    // a state the screen contradicts.
    commandFails = true;
    const patches: Array<{ statusbar_enabled: boolean }> = [];
    const result = await setSubtitleBarVisible(false, (p) => {
      patches.push(p);
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.detail).toContain("status bar window is gone");
    // Set, then put back — the final stored value matches what is on screen.
    expect(patches).toEqual([{ statusbar_enabled: false }, { statusbar_enabled: true }]);
  });

  it("records the preference and calls nothing outside the desktop app", async () => {
    // The web preview has no bar to move, so the preference is the whole of the
    // work — and inventing a failure there would be wrong too.
    tauri = false;
    const patches: Array<{ statusbar_enabled: boolean }> = [];
    const result = await setSubtitleBarVisible(false, (p) => {
      patches.push(p);
    });

    expect(result.ok).toBe(true);
    expect(patches).toEqual([{ statusbar_enabled: false }]);
    expect(calls).toEqual([]);
  });

  it("shows it again by the same path", async () => {
    const patches: Array<{ statusbar_enabled: boolean }> = [];
    await setSubtitleBarVisible(true, (p) => {
      patches.push(p);
    });
    expect(patches).toEqual([{ statusbar_enabled: true }]);
    expect(calls).toEqual([{ cmd: "statusbar_set_visible", args: { visible: true } }]);
  });

  it("awaits an async persist before touching the window", async () => {
    // Ordering matters: the command must not fire against a preference that has
    // not been written yet, or a failed write would leave them disagreeing.
    const order: string[] = [];
    await setSubtitleBarVisible(false, async () => {
      await Promise.resolve();
      order.push("persisted");
    });
    order.push("returned");
    expect(order).toEqual(["persisted", "returned"]);
    expect(calls).toHaveLength(1);
  });
});
