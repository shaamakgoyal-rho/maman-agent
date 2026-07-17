import { useEffect, useState } from "react";
import { hidePanel, onAppEvent, emitAppEvent } from "../lib/bridge.js";
import type { PetStateName } from "../pet/machine.js";
import { useSettings } from "../state/settings.js";
import { Onboarding } from "./screens/Onboarding.js";
import { Home } from "./screens/Home.js";
import { Privacy } from "./screens/Privacy.js";
import { Settings } from "./screens/Settings.js";
import { Activity } from "./screens/Activity.js";
import { Suggestions } from "./screens/Suggestions.js";
import { Agents } from "./screens/Agents.js";

const TABS = ["Home", "Suggestions", "Agents", "Activity", "Privacy", "Settings"] as const;
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
        {tab === "Activity" && <Activity />}
        {tab === "Privacy" && <Privacy />}
        {tab === "Settings" && <Settings />}
      </div>
    </main>
  );
}
