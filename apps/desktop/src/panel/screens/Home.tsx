import { useEffect, useState } from "react";
import { demoHistoryFixture, reconciliationFixture } from "@maman/demo-fixtures";
import { useRecommendations } from "../../lib/recommendations.js";
import { capabilitySnapshot, type CapabilityLine } from "../../lib/capabilities.js";
import { useSettings, pauseUntil } from "../../state/settings.js";
import { Button, Card, EmptyState, Muted, SectionTitle, StatusPill } from "../ui.js";
import { PET_STATE_DESCRIPTIONS } from "../../pet/renderer.js";
import type { PetStateName } from "../../pet/machine.js";
import { ingestEvents, type IngestResult } from "../../lib/events.js";
import { emitAppEvent } from "../../lib/bridge.js";

export function Home({ petState }: { petState: PetStateName }) {
  const { settings, update } = useSettings();
  const paused = settings.observation_paused;
  const [demoResult, setDemoResult] = useState<IngestResult | null>(null);
  const [demoBusy, setDemoBusy] = useState(false);
  const [capabilities, setCapabilities] = useState<CapabilityLine[]>([]);

  useEffect(() => {
    void capabilitySnapshot(settings).then(setCapabilities);
  }, [settings]);

  const runDemoWorkflow = async () => {
    setDemoBusy(true);
    try {
      // Deterministic demo observer: injects the six-episode reconciliation
      // fixture through the full gate → redact → encrypt pipeline.
      await emitAppEvent({ type: "simulate_pet_event", event: "OBSERVING_STARTED" });
      const result = await ingestEvents(reconciliationFixture(), {
        observationPaused: settings.observation_paused,
      });
      setDemoResult(result);
      await emitAppEvent({ type: "simulate_pet_event", event: "OBSERVING_STOPPED" });
    } finally {
      setDemoBusy(false);
    }
  };

  /**
   * Demo seed (dev): loads a realistic month — 23 recorded runs of the
   * reconciliation workflow, two done differently on purpose — through the SAME
   * gate → redact → encrypt pipeline, then scores it. The resulting card reads
   * "tested against your last 21 runs, matched 19": honest, not staged.
   */
  const seedDemoHistory = async () => {
    setDemoBusy(true);
    try {
      await emitAppEvent({ type: "simulate_pet_event", event: "OBSERVING_STARTED" });
      const result = await ingestEvents(demoHistoryFixture(), {
        observationPaused: settings.observation_paused,
      });
      setDemoResult(result);
      await emitAppEvent({ type: "simulate_pet_event", event: "OBSERVING_STOPPED" });
      // Score immediately (the background loop would get there within a minute).
      await emitAppEvent({ type: "simulate_pet_event", event: "THINKING_STARTED" });
      await useRecommendations.getState().refresh();
      await emitAppEvent({ type: "simulate_pet_event", event: "THINKING_FINISHED" });
    } finally {
      setDemoBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <Card>
        <div className="flex items-center justify-between">
          <SectionTitle>Observation</SectionTitle>
          <StatusPill tone={paused ? "muted" : "success"}>
            {paused ? "Paused" : "Observing"}
          </StatusPill>
        </div>
        <Muted>{PET_STATE_DESCRIPTIONS[petState]}</Muted>
        {!paused && settings.allowlist_domains.length > 0 && (
          <Muted>
            Watching {settings.allowlist_domains.length} allowed{" "}
            {settings.allowlist_domains.length === 1 ? "site" : "sites"} · browser category
          </Muted>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          {paused ? (
            <Button onClick={() => void update({ observation_paused: false, paused_until: null })}>
              Resume observation
            </Button>
          ) : (
            <>
              <Button
                variant="secondary"
                onClick={() => void update({ observation_paused: true, ...pauseUntil(15) })}
              >
                Pause 15 min
              </Button>
              <Button
                variant="secondary"
                onClick={() => void update({ observation_paused: true, ...pauseUntil(60) })}
              >
                Pause 1 hour
              </Button>
              <Button
                variant="secondary"
                onClick={() => void update({ observation_paused: true, ...pauseUntil("tomorrow") })}
              >
                Until tomorrow
              </Button>
            </>
          )}
        </div>
      </Card>

      <Card>
        <SectionTitle>Maman can currently use</SectionTitle>
        <ul className="space-y-1.5">
          {capabilities.map((line) => (
            <li key={line.label} className="flex items-start justify-between gap-2 text-sm">
              <span className="shrink-0 font-medium">{line.label}</span>
              <span className="text-right text-xs text-muted">{line.detail}</span>
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <SectionTitle>Today's verified time saved</SectionTitle>
        <p className="text-2xl font-semibold tabular-nums">0 min</p>
        <Muted>Verified savings appear after your first approved agent run.</Muted>
      </Card>

      <Card>
        <SectionTitle>Demo</SectionTitle>
        <Muted>
          Both run through the real observation pipeline (gating, redaction, encryption). “Seed demo
          history” loads a realistic month — 23 recorded reconciliation runs, two of them done
          differently on purpose — so the suggestion card can honestly show a tested, imperfect
          score. Inspect everything in Activity.
        </Muted>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button onClick={() => void seedDemoHistory()} disabled={demoBusy}>
            Seed demo history (23 runs)
          </Button>
          <Button variant="secondary" onClick={() => void runDemoWorkflow()} disabled={demoBusy}>
            Run demo workflow
          </Button>
          {demoResult && (
            <span className="text-xs text-muted tabular-nums">
              {demoResult.stored} stored
              {demoResult.dropped_paused > 0 && ` · ${demoResult.dropped_paused} dropped (paused)`}
              {demoResult.dropped_not_allowlisted > 0 &&
                ` · ${demoResult.dropped_not_allowlisted} not allowlisted`}
              {demoResult.boundary_events > 0 && ` · ${demoResult.boundary_events} boundary`}
            </span>
          )}
        </div>
      </Card>

      <EmptyState
        title="No suggestions yet"
        body="Once Maman has noticed a repeated workflow AND tested a helper against your own recorded runs, a card with the score appears in Suggestions."
      />
    </div>
  );
}
