import { invokeCommand, isTauri } from "./bridge.js";

/**
 * Shows or hides the subtitle bar, from wherever the user asked.
 *
 * ONE implementation for two controls. The bar can be turned off from the Home
 * screen — where it belongs, next to what it is narrating — and from Settings.
 * Two inlined copies of "update the preference, then call the command" would
 * drift, and the failure mode is specific: a preference that says hidden while
 * the window is still sitting on top of the user's screen.
 *
 * The preference is only kept if the window actually obeyed. A stored `false`
 * over a visible bar is the setting failing in the most visible possible way,
 * so a failed command rolls the preference back rather than leaving the two
 * disagreeing with no way to tell which is true.
 */
export async function setSubtitleBarVisible(
  visible: boolean,
  persist: (patch: { statusbar_enabled: boolean }) => Promise<void> | void,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  await persist({ statusbar_enabled: visible });

  // No Tauri means no bar to move — the web preview has nothing to show, and
  // recording the preference is the whole of the work there.
  if (!isTauri()) return { ok: true };

  try {
    await invokeCommand("statusbar_set_visible", { visible });
    return { ok: true };
  } catch (e) {
    await persist({ statusbar_enabled: !visible });
    return {
      ok: false,
      detail: e instanceof Error ? e.message : "the subtitle bar did not respond",
    };
  }
}
