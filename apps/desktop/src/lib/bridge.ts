/**
 * Platform bridge. Every Tauri touchpoint goes through here so the same UI
 * runs inside the desktop app AND as a plain web preview (CI / non-macOS demo).
 * Web preview fallbacks: localStorage for settings, BroadcastChannel for the
 * cross-window event bus, no-ops for window management.
 */

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function invokeCommand<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

// ---- cross-window app events ----

import type { StatusBeat } from "./status.js";

export type AppEvent =
  | { type: "observation_changed" }
  | { type: "settings_changed" }
  | { type: "pet_state_probe" }
  | { type: "pet_state_report"; state: string }
  | { type: "simulate_pet_event"; event: string }
  /** A pipeline moment for the status bar (see lib/status.ts). */
  | { type: "status_beat"; beat: StatusBeat };

type Listener = (event: AppEvent) => void;

const CHANNEL = "maman-app-events";
let channel: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel {
  channel ??= new BroadcastChannel(CHANNEL);
  return channel;
}

export async function emitAppEvent(event: AppEvent): Promise<void> {
  if (isTauri()) {
    const { emit } = await import("@tauri-apps/api/event");
    await emit(CHANNEL, event);
  } else {
    getChannel().postMessage(event);
  }
}

export async function onAppEvent(listener: Listener): Promise<() => void> {
  if (isTauri()) {
    const { listen } = await import("@tauri-apps/api/event");
    const unlisten = await listen<AppEvent>(CHANNEL, (e) => listener(e.payload));
    return unlisten;
  }
  const handler = (e: MessageEvent) => listener(e.data as AppEvent);
  getChannel().addEventListener("message", handler);
  return () => getChannel().removeEventListener("message", handler);
}

// ---- settings persistence ----

const SETTINGS_KEY = "maman-local-settings";

export async function loadSettingsRaw(): Promise<string | null> {
  if (isTauri()) {
    return invokeCommand<string | null>("settings_load");
  }
  return localStorage.getItem(SETTINGS_KEY);
}

export async function saveSettingsRaw(json: string): Promise<void> {
  if (isTauri()) {
    await invokeCommand("settings_save", { json });
    return;
  }
  localStorage.setItem(SETTINGS_KEY, json);
}

// ---- window management ----

export async function togglePanel(): Promise<void> {
  if (isTauri()) {
    await invokeCommand("toggle_panel");
  }
  // Web preview renders the panel in its own tab; nothing to toggle.
}

export async function hidePanel(): Promise<void> {
  if (isTauri()) await invokeCommand("hide_panel");
}

export async function startPetDrag(): Promise<void> {
  if (!isTauri()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().startDragging();
}

export async function quitApp(): Promise<void> {
  if (isTauri()) await invokeCommand("quit_app");
}
