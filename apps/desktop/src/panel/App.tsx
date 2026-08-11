import { useEffect, useState } from "react";
import { hidePanel, onAppEvent, emitAppEvent } from "../lib/bridge.js";
import type { PetStateName } from "../pet/machine.js";
import { useSettings } from "../state/settings.js";
import { Onboarding } from "./screens/Onboarding.js";
import { Mother } from "./screens/Mother.js";
import { Agents } from "./screens/Agents.js";
import { Privacy } from "./screens/Privacy.js";
import { useLearnedWorkflows } from "../lib/learnedWorkflows.js";

/**
 * THREE DESTINATIONS, NOT SIX TABS PLUS TWO TAKEOVERS.
 *
 * What this replaced: Home, Suggestions, Agents, Activity, Privacy, Settings —
 * plus Configure and Teach as content-area takeovers. That navigation exposed
 * the implementation (pipelines, replay evidence, execution lanes, detection
 * thresholds, demo seeding, server enrollment) rather than the product.
 *
 *  - Mother — what Maman is doing, the ONE best suggestion, recent work.
 *  - Agents — what exists, what it does, Test / Pause / Delete.
 *  - Privacy & access — monitoring, exclusions, permissions, deletion, Advanced.
 *
 * Configure and Teach are GONE from the primary journey: a mother agent that
 * watched you work and then hands you a field-mapping form has not learned
 * anything. A value Maman cannot infer becomes a runtime input slot the pet asks
 * about inline, at the moment it is needed.
 *
 * This component owns NO timers. The proactive loop lives in `lib/motherLoop.ts`
 * at module scope (booted from the panel entry), so proactivity outlives any
 * mounted screen; trigger evaluation and firing already live in the native
 * daemon. React is a subscriber here, not the owner.
 */
const TABS = ["Mother", "Agents", "Privacy & access"] as const;
type Tab = (typeof TABS)[number];

export function App() {
  const { settings, hydrated, hydrate } = useSettings();
  const [tab, setTab] = useState<Tab>("Mother");
  const [reportedPetState, setReportedPetState] = useState<PetStateName | null>(null);
  const petState: PetStateName =
    reportedPetState ?? (settings.observation_paused ? "sleeping" : "looking_around");
  const [blockingApproval] = useState(false);

  useEffect(() => {
    void hydrate();
    void useLearnedWorkflows.getState().hydrate();
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
        {tab === "Mother" && <Mother petState={petState} />}
        {tab === "Agents" && <Agents />}
        {tab === "Privacy & access" && <Privacy />}
      </div>
    </main>
  );
}
