import { useEffect, useRef, useState } from "react";
import { invokeCommand, isTauri, loadSettingsRaw, onAppEvent } from "../lib/bridge.js";
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
      }}
      role="status"
      aria-live="polite"
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
