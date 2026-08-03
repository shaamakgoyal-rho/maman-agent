import { useEffect, useRef, useState } from "react";
import {
  invokeCommand,
  isTauri,
  loadSettingsRaw,
  onAppEvent,
  saveSettingsRaw,
} from "../lib/bridge.js";
import {
  statusLine,
  STICKY_HOLD_MS,
  type ObservationHealth,
  type StatusBeat,
} from "../lib/status.js";

/**
 * The subtitle bar: one honest line about what Maman is doing right now, with
 * a dot that is green ONLY when the observer is genuinely observing. Renders
 * in its own thin always-on-top window; a thin shell over lib/status.ts.
 *
 * Sticky beats (agent creation, approvals, run results) hold the bar for
 * STICKY_HOLD_MS, then it falls back to the latest funnel state.
 */
export function StatusBar() {
  const [beat, setBeat] = useState<StatusBeat>({ kind: "idle" });
  const [health, setHealth] = useState<ObservationHealth>({
    observer: isTauri() ? "starting" : "observing", // web preview simulates observation
    paused: false,
    store: "ok",
  });
  // The latest non-sticky beat, to fall back to when a sticky one expires.
  const fallback = useRef<StatusBeat>({ kind: "idle" });
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * True from the moment the user presses on the bar until the resulting move has
   * been recorded. Distinguishes a real drag from the automatic placement the
   * core performs, which fires the same Moved event.
   */
  const userDragging = useRef(false);

  useEffect(() => {
    let disposed = false;
    const unlisten = onAppEvent((event) => {
      if (disposed || event.type !== "status_beat") return;
      const incoming = event.beat;
      const sticky =
        incoming.kind !== "idle" && incoming.kind !== "watching" && incoming.kind !== "suggested";
      if (sticky) {
        setBeat(incoming);
        if (holdTimer.current) clearTimeout(holdTimer.current);
        holdTimer.current = setTimeout(() => {
          holdTimer.current = null; // release the hold, or it sticks forever
          setBeat(fallback.current);
        }, STICKY_HOLD_MS);
      } else {
        fallback.current = incoming;
        // Only replace the display if nothing sticky is holding the bar;
        // otherwise the running hold falls back to this newer state.
        if (!holdTimer.current) setBeat(incoming);
      }
    });
    return () => {
      disposed = true;
      void unlisten.then((u) => u());
      if (holdTimer.current) clearTimeout(holdTimer.current);
    };
  }, []);

  /**
   * Dragging: the bar is a drag region (see the root element), so macOS moves the
   * window and we only have to remember where it ended up. Once the user places
   * it by hand we turn OFF follow-the-window — an automatic placement that
   * fights a deliberate choice is worse than none — and Settings offers a reset.
   *
   * Debounced 450ms like the pet, so one drag writes once instead of per frame.
   */
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let settle: ReturnType<typeof setTimeout> | null = null;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      if (disposed) return;
      unlisten = await getCurrentWindow().onMoved(() => {
        // ONLY a move the user started counts. Docking and the startup anchor
        // move this window too, and treating those as a drag made the feature
        // disable itself: the first automatic placement turned following off.
        if (!userDragging.current) return;
        if (settle) clearTimeout(settle);
        settle = setTimeout(() => {
          userDragging.current = false;
          void invokeCommand("statusbar_position_save").catch(() => {});
          // Persist the mode change through the same settings file the panel
          // owns; a merge-read keeps us from clobbering concurrent edits.
          void (async () => {
            try {
              const raw = await loadSettingsRaw();
              const current = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
              if (current["statusbar_follow_window"] === false) return;
              await saveSettingsRaw(JSON.stringify({ ...current, statusbar_follow_window: false }));
            } catch {
              // The position is already saved; the mode flag is best-effort.
            }
          })();
        }, 450);
      });
    })();
    return () => {
      disposed = true;
      if (settle) clearTimeout(settle);
      unlisten?.();
    };
  }, []);

  // Health poll: the dot must reflect the REAL observer, not assumptions.
  useEffect(() => {
    let active = true;
    const tick = async () => {
      try {
        const raw = await loadSettingsRaw();
        const paused = raw ? Boolean(JSON.parse(raw).observation_paused) : false;
        const observer = isTauri() ? await invokeCommand<string>("observer_status") : "observing";
        const store = isTauri() ? await invokeCommand<string>("store_status") : "ok";
        if (active) setHealth({ observer, paused, store });
      } catch {
        // Leave the previous health: a failed poll is not evidence of health.
      }
    };
    void tick();
    const interval = setInterval(() => void tick(), 5_000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  const line = statusLine(beat, health);
  const dotColor = { green: "#22c55e", amber: "#f59e0b", gray: "#9ca3af", red: "#ef4444" }[
    line.dot
  ];

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        height: 32,
        margin: 4,
        padding: "0 12px",
        borderRadius: 16,
        background: "rgba(20, 20, 24, 0.86)",
        color: "#f4f4f5",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
        fontSize: 12,
        lineHeight: "32px",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        boxShadow: "0 2px 10px rgba(0,0,0,0.25)",
        cursor: "grab",
        // Text selection would fight the drag gesture.
        userSelect: "none",
      }}
      role="status"
      aria-live="polite"
      // The whole bar is the drag handle. It only receives the mouse when
      // click-through is off (the default); with click-through on, this attribute
      // is inert because the window never sees the pointer.
      data-tauri-drag-region
      title="Drag to move"
      onPointerDown={() => {
        userDragging.current = true;
      }}
    >
      <span
        aria-label={`status ${line.dot}`}
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          background: dotColor,
          flexShrink: 0,
          boxShadow: line.dot === "green" ? `0 0 6px ${dotColor}` : "none",
        }}
      />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{line.text}</span>
    </div>
  );
}

/**
 * Whether a window Moved event should be treated as the user placing the bar.
 *
 * Extracted and exported for tests because getting this wrong is invisible and
 * self-defeating: the core moves this window itself (startup anchor, docking to
 * the monitored window), and those moves fire the same event a drag does. Taking
 * them for drags turned following OFF on the first automatic placement, which
 * quietly disabled docking altogether.
 */
export function isUserInitiatedMove(pointerPressedOnBar: boolean): boolean {
  return pointerPressedOnBar;
}
