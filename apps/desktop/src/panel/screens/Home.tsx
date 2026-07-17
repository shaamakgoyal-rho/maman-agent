import { useState } from "react";
import { reconciliationFixture } from "@maman/demo-fixtures";
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
        <SectionTitle>Today's verified time saved</SectionTitle>
        <p className="text-2xl font-semibold tabular-nums">0 min</p>
        <Muted>Verified savings appear after your first approved agent run.</Muted>
      </Card>

      <Card>
        <SectionTitle>Demo</SectionTitle>
        <Muted>
          Injects the deterministic six-episode reconciliation fixture through the real observation
          pipeline (gating, redaction, encryption). Inspect it in Activity.
        </Muted>
        <div className="mt-2 flex items-center gap-3">
          <Button onClick={() => void runDemoWorkflow()} disabled={demoBusy}>
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
        body="Once Maman has seen a workflow repeat at least three times across two days, a suggestion with full evidence will appear here."
      />
    </div>
  );
}
