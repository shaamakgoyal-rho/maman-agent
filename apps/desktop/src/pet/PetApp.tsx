import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMachine } from "@xstate/react";
import { petWindow } from "@maman/config";
import { petMachine, type PetEvent, type PetStateName } from "./machine.js";
import { describeAnimationState } from "./renderer.js";
import { SpriteMaman } from "./SpriteMaman.js";
import type { MamanAnimationState } from "./atlas.js";
import { GAZE_LINGER_MS, gazeFrameForPointer } from "./gaze.js";
import {
  emitAppEvent,
  isTauri,
  onAppEvent,
  quitApp,
  startPetDrag,
  togglePanel,
} from "../lib/bridge.js";
import { pauseUntil, useSettings } from "../state/settings.js";

const DRAG_HOLD_MS = petWindow.dragHoldMs;

type MenuItem = { label: string; action: () => void | Promise<void> } | { separator: true };

export function PetApp() {
  const [snapshot, send] = useMachine(petMachine);
  const { settings, hydrate, update } = useSettings();
  const [menuOpen, setMenuOpen] = useState(false);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragging = useRef(false);

  // Renderer-level movement state (running-left/right while the window moves).
  const [moving, setMoving] = useState<"moving_left" | "moving_right" | null>(null);
  const lastX = useRef<number | null>(null);
  const moveSettleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Engagement-gated gaze: active on hover and for 1.5s after interaction.
  const [gazeFrame, setGazeFrame] = useState<{ row: number; column: number } | null>(null);
  const gazeLingerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hovering = useRef(false);

  const machineState = snapshot.value as PetStateName;
  const state: MamanAnimationState = moving ?? machineState;

  const reducedMotion =
    settings.reduced_motion === "on" ||
    (settings.reduced_motion === "system" &&
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // Drive machine from settings (pause state) and cross-window events.
  useEffect(() => {
    send({
      type: settings.observation_paused ? "OBSERVATION_PAUSED" : "OBSERVATION_RESUMED",
    });
  }, [settings.observation_paused, send]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void onAppEvent((event) => {
      if (event.type === "settings_changed") void useSettings.getState().hydrate();
      if (event.type === "pet_state_probe") {
        void emitAppEvent({ type: "pet_state_report", state: machineState });
      }
      if (event.type === "simulate_pet_event") {
        // Used by the demo flow and E2E tests to exercise every state.
        send({ type: event.event } as PetEvent);
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [send, machineState]);

  // Report state changes so the panel status line stays current. Log entries
  // contain the state name only — never private payloads.
  useEffect(() => {
    void emitAppEvent({ type: "pet_state_report", state: machineState });
  }, [machineState]);

  // Movement detection: while the OS window moves (drag), play the run cycle
  // in the movement direction; settle back to the product state afterwards.
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      unlisten = await getCurrentWindow().onMoved(({ payload }) => {
        if (reducedMotion) return; // no walking under reduced motion
        const x = payload.x;
        if (lastX.current !== null && Math.abs(x - lastX.current) > 1) {
          setMoving(x > lastX.current ? "moving_right" : "moving_left");
        }
        lastX.current = x;
        if (moveSettleTimer.current) clearTimeout(moveSettleTimer.current);
        moveSettleTimer.current = setTimeout(() => setMoving(null), 350);
      });
    })();
    return () => unlisten?.();
  }, [reducedMotion]);

  // ---- gaze engagement ----

  const updateGaze = useCallback(
    (clientX: number, clientY: number) => {
      if (reducedMotion) return; // no automatic gaze under reduced motion
      const cx = window.innerWidth / 2;
      const cy = window.innerHeight / 2;
      setGazeFrame(gazeFrameForPointer(clientX - cx, clientY - cy));
    },
    [reducedMotion],
  );

  const lingerThenClearGaze = useCallback(() => {
    if (gazeLingerTimer.current) clearTimeout(gazeLingerTimer.current);
    gazeLingerTimer.current = setTimeout(() => {
      if (!hovering.current) setGazeFrame(null);
    }, GAZE_LINGER_MS);
  }, []);

  // ---- interactions ----

  const onPointerDown = useCallback(() => {
    dragging.current = false;
    holdTimer.current = setTimeout(() => {
      dragging.current = true;
      void startPetDrag();
    }, DRAG_HOLD_MS);
  }, []);

  const onPointerUp = useCallback(() => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    if (!dragging.current) {
      // Plain click: open the panel; acknowledge a failure state first.
      if (machineState === "failed") send({ type: "FAILURE_ACKNOWLEDGED" });
      void togglePanel();
    }
    // Dragging cancels click-to-open.
    dragging.current = false;
    lingerThenClearGaze();
  }, [machineState, send, lingerThenClearGaze]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (machineState === "failed") send({ type: "FAILURE_ACKNOWLEDGED" });
        void togglePanel();
      }
      if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
        e.preventDefault();
        setMenuOpen(true);
      }
    },
    [machineState, send],
  );

  const menu: MenuItem[] = useMemo(
    () => [
      { label: "Open Maman", action: () => togglePanel() },
      { separator: true },
      {
        label: "Pause for 15 minutes",
        action: () => update({ observation_paused: true, ...pauseUntil(15) }),
      },
      {
        label: "Pause for 1 hour",
        action: () => update({ observation_paused: true, ...pauseUntil(60) }),
      },
      {
        label: "Pause until tomorrow",
        action: () => update({ observation_paused: true, ...pauseUntil("tomorrow") }),
      },
      {
        label: "Resume observation",
        action: () => update({ observation_paused: false, paused_until: null }),
      },
      { separator: true },
      { label: "Start Teach Mode", action: () => togglePanel() },
      { label: "What Maman can see", action: () => togglePanel() },
      { label: "Agents", action: () => togglePanel() },
      { label: "Settings", action: () => togglePanel() },
      { separator: true },
      { label: "Quit", action: () => quitApp() },
    ],
    [update],
  );

  return (
    <div
      style={{
        width: "100%",
        height: "100vh",
        cursor: "pointer",
        userSelect: "none",
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
      }}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerEnter={() => {
        hovering.current = true;
      }}
      onPointerMove={(e) => {
        if (hovering.current) updateGaze(e.clientX, e.clientY);
      }}
      onPointerLeave={() => {
        hovering.current = false;
        if (holdTimer.current) clearTimeout(holdTimer.current);
        lingerThenClearGaze();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenuOpen((v) => !v);
      }}
      onKeyDown={onKeyDown}
      tabIndex={0}
      aria-label="Maman pet. Press Enter to open the panel, Shift+F10 for the menu."
    >
      <SpriteMaman
        state={state}
        size={96}
        reducedMotion={reducedMotion}
        ariaLabel={describeAnimationState(state)}
        gazeFrame={gazeFrame}
      />
      {/* Screen-reader live region announcing state changes */}
      <span
        aria-live="polite"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          overflow: "hidden",
          clipPath: "inset(50%)",
        }}
      >
        {describeAnimationState(state)}
      </span>

      {menuOpen && (
        <div
          role="menu"
          aria-label="Maman menu"
          style={{
            position: "fixed",
            bottom: 4,
            right: 4,
            background: "#FFFFFF",
            border: "1px solid #E7E2DA",
            borderRadius: 12,
            boxShadow: "0 4px 16px rgba(32,36,42,0.12)",
            padding: 4,
            minWidth: 180,
            fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, sans-serif',
            fontSize: 12,
            zIndex: 10,
          }}
        >
          {menu.map((item, i) =>
            "separator" in item ? (
              <hr key={i} style={{ border: 0, borderTop: "1px solid #E7E2DA", margin: "4px 0" }} />
            ) : (
              <button
                key={item.label}
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  void item.action();
                }}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "6px 10px",
                  border: 0,
                  background: "transparent",
                  borderRadius: 8,
                  cursor: "pointer",
                  color: "#20242A",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "#F4F1EA")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                {item.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
