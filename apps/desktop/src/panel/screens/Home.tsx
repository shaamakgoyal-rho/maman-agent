import { useEffect, useState } from "react";
import {
  demoHistoryFixture,
  liveWorkflowRepFixture,
  reconciliationFixture,
} from "@maman/demo-fixtures";
import { useRecommendations } from "../../lib/recommendations.js";
import { capabilitySnapshot, type CapabilityLine } from "../../lib/capabilities.js";
import { useSettings, pauseUntil } from "../../state/settings.js";
import { Button, Card, EmptyState, Muted, SectionTitle, StatusPill } from "../ui.js";
import { PET_STATE_DESCRIPTIONS } from "../../pet/renderer.js";
import type { PetStateName } from "../../pet/machine.js";
import { ingestEvents, type IngestResult } from "../../lib/events.js";
import { emitAppEvent } from "../../lib/bridge.js";

// Synthetic timeline for the simulated live reps: anchored (backdated ~10min)
// on the first click of this session so rapid clicks still produce a clean,
// same-day, back-to-back sequence like real repeated work.
let liveSimBaseAtMs: number | null = null;
let liveSimRepIndex = 0;

export function Home({ petState }: { petState: PetStateName }) {
  const { settings, update } = useSettings();
  const paused = settings.observation_paused;
  const [demoResult, setDemoResult] = useState<IngestResult | null>(null);
  const [demoBusy, setDemoBusy] = useState(false);
  const [liveRepCount, setLiveRepCount] = useState(0);
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
   * Simulated LIVE rep: ingests ONE repetition shaped exactly as the Chrome
   * relay records real work (point-in-time events, no durations, field commits
   * as value_committed, URL-derived context) through the same pipeline. Lets
   * the live arc run without a paired extension; the truly-live path is the
   * relay itself (docs/LIVE_DEMO.md).
   */
  const simulateLiveRep = async () => {
    setDemoBusy(true);
    try {
      liveSimBaseAtMs ??= Date.now() - 10 * 60_000;
      const rep = liveSimRepIndex++;
      await emitAppEvent({ type: "simulate_pet_event", event: "OBSERVING_STARTED" });
      const result = await ingestEvents(
        liveWorkflowRepFixture({ rep_index: rep, base_at_ms: liveSimBaseAtMs }),
        { observationPaused: settings.observation_paused },
      );
      setDemoResult(result);
      setLiveRepCount(rep + 1);
      await emitAppEvent({ type: "simulate_pet_event", event: "OBSERVING_STOPPED" });
      await emitAppEvent({ type: "simulate_pet_event", event: "THINKING_STARTED" });
      await useRecommendations.getState().refresh();
      await emitAppEvent({ type: "simulate_pet_event", event: "THINKING_FINISHED" });
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
          All of these run through the real observation pipeline (gating, redaction, encryption).
          “Seed demo history” loads a realistic month — 23 recorded reconciliation runs, two of them
          done differently on purpose — so the suggestion card can honestly show a tested, imperfect
          score. “Simulate live workflow rep” ingests one repetition shaped exactly as the Chrome
          relay records live work (no durations, field commits only) — click it 4× with the Live
          demo preset on to walk the live arc without a paired extension. Inspect everything in
          Activity.
        </Muted>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button onClick={() => void seedDemoHistory()} disabled={demoBusy}>
            Seed demo history (23 runs)
          </Button>
          <Button variant="secondary" onClick={() => void runDemoWorkflow()} disabled={demoBusy}>
            Run demo workflow
          </Button>
          <Button variant="secondary" onClick={() => void simulateLiveRep()} disabled={demoBusy}>
            Simulate live workflow rep{liveRepCount > 0 ? ` (${liveRepCount})` : ""}
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
