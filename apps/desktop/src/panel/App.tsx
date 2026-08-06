import { useEffect, useRef, useState } from "react";
import { hidePanel, onAppEvent, emitAppEvent } from "../lib/bridge.js";
import type { PetStateName } from "../pet/machine.js";
import { useSettings } from "../state/settings.js";
import { useRecommendations } from "../lib/recommendations.js";
import { Onboarding } from "./screens/Onboarding.js";
import { Home } from "./screens/Home.js";
import { Privacy } from "./screens/Privacy.js";
import { Settings } from "./screens/Settings.js";
import { Activity } from "./screens/Activity.js";
import { Suggestions } from "./screens/Suggestions.js";
import { Agents } from "./screens/Agents.js";
import { Teach } from "./screens/Teach.js";

const TABS = ["Home", "Suggestions", "Agents", "Teach", "Activity", "Privacy", "Settings"] as const;
type Tab = (typeof TABS)[number];

export function App() {
  const { settings, hydrated, hydrate } = useSettings();
  const [tab, setTab] = useState<Tab>("Home");
  const [reportedPetState, setReportedPetState] = useState<PetStateName | null>(null);
  // Until the pet window reports, derive the display state from settings.
  const petState: PetStateName =
    reportedPetState ?? (settings.observation_paused ? "sleeping" : "looking_around");
  // Approval view is a blocking panel state (M7 wires real approvals).
  const [blockingApproval] = useState(false);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void onAppEvent((event) => {
      if (event.type === "settings_changed") void useSettings.getState().hydrate();
      if (event.type === "pet_state_report") setReportedPetState(event.state as PetStateName);
    }).then((fn) => {
      unlisten = fn;
    });
    void emitAppEvent({ type: "pet_state_probe" });
    return () => unlisten?.();
  }, []);

  // Proactive suggestion loop — the core "Maman notices repeated work and gently
  // offers help" behavior. The panel webview is always alive (even while the
  // window is hidden), so it periodically re-runs the pattern engine over
  // observed activity and, when a NEW suggestion clears the surfacing policy
  // (daily budget, quiet hours, not paused), tells the pet to wave. Without this
  // the pipeline only ran when a tab was open and the pet never surfaced anything.
  const wavingRef = useRef(false);
  useEffect(() => {
    if (!hydrated || !settings.onboarding_complete) return;
    let cancelled = false;
    let running = false;
    const tick = async () => {
      if (running || cancelled) return;
      running = true;
      try {
        // The pet shows a distinct "thinking" state while a pattern is scored —
        // the worker always knows when Maman is working on their history.
        await emitAppEvent({ type: "simulate_pet_event", event: "THINKING_STARTED" });
        await useRecommendations.getState().refresh();
        await emitAppEvent({ type: "simulate_pet_event", event: "THINKING_FINISHED" });
        if (cancelled) return;
        const st = useRecommendations.getState();
        const hasNew = st.items.some((i) => i.entry.status === "new");
        if (hasNew && !wavingRef.current && (await st.maybeSurface())) {
          wavingRef.current = true;
          await emitAppEvent({ type: "simulate_pet_event", event: "SUGGESTION_READY" });
        } else if (!hasNew && wavingRef.current) {
          wavingRef.current = false;
          await emitAppEvent({ type: "simulate_pet_event", event: "SUGGESTION_HANDLED" });
        }
      } catch {
        // A background tick must never crash the panel.
      } finally {
        running = false;
      }
    };
    const initial = setTimeout(() => void tick(), 4000);
    const id = setInterval(() => void tick(), 60_000);
    return () => {
      cancelled = true;
      clearTimeout(initial);
      clearInterval(id);
    };
  }, [hydrated, settings.onboarding_complete]);

  // Escape closes the panel unless a blocking approval is open.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !blockingApproval) void hidePanel();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [blockingApproval]);

  // Outside click: hide when the window loses focus (no write ever happens on close).
  useEffect(() => {
    const handler = () => {
      if (!blockingApproval) void hidePanel();
    };
    window.addEventListener("blur", handler);
    return () => window.removeEventListener("blur", handler);
  }, [blockingApproval]);

  if (!hydrated) return null;

  if (!settings.onboarding_complete) {
    return (
      <main className="h-screen bg-bg">
        <Onboarding />
      </main>
    );
  }

  return (
    <main className="flex h-screen flex-col bg-bg">
      <nav
        aria-label="Panel sections"
        className="flex gap-0.5 border-b border-line bg-panel px-2 pt-2"
      >
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            aria-current={tab === t ? "page" : undefined}
            className={`rounded-t-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
              tab === t ? "text-primary border-b-2 border-primary" : "text-muted hover:text-ink"
            }`}
          >
            {t}
          </button>
        ))}
      </nav>
      <div className="flex-1 overflow-y-auto p-4">
        {tab === "Home" && <Home petState={petState} />}
        {tab === "Suggestions" && <Suggestions />}
        {tab === "Agents" && <Agents />}
        {tab === "Teach" && <Teach />}
        {tab === "Activity" && <Activity />}
        {tab === "Privacy" && <Privacy />}
        {tab === "Settings" && <Settings />}
      </div>
    </main>
  );
}
