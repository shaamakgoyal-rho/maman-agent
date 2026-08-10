import { useEffect, useState } from "react";
import {
  demoHistoryFixture,
  finopsMonthEndRepFixture,
  finopsThreeWayRepFixture,
  liveWorkflowRepFixture,
  revopsRenewalRepFixture,
  reconciliationFixture,
} from "@maman/demo-fixtures";
import { useRecommendations } from "../../lib/recommendations.js";
import { capabilitySnapshot, type CapabilityLine } from "../../lib/capabilities.js";
import { useSettings, pauseUntil } from "../../state/settings.js";
import { setSubtitleBarVisible } from "../../lib/statusbar.js";
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
let domainSimBaseAtMs: number | null = null;
let domainSimRepIndex = 0;
let monthEndSimBaseAtMs: number | null = null;
let monthEndSimRepIndex = 0;
let renewalSimBaseAtMs: number | null = null;
let renewalSimRepIndex = 0;

export function Home({ petState }: { petState: PetStateName }) {
  const { settings, update } = useSettings();
  const paused = settings.observation_paused;
  const [demoResult, setDemoResult] = useState<IngestResult | null>(null);
  const [demoBusy, setDemoBusy] = useState(false);
  const [liveRepCount, setLiveRepCount] = useState(0);
  const [finopsRepCount, setFinopsRepCount] = useState(0);
  const [monthEndRepCount, setMonthEndRepCount] = useState(0);
  const [renewalRepCount, setRenewalRepCount] = useState(0);
  const [capabilities, setCapabilities] = useState<CapabilityLine[]>([]);
  const [barError, setBarError] = useState<string | null>(null);

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
   * Simulated FinOps rep: one repetition of the finops three_way_match PACK
   * workflow, classified by the real domain classifier. Two clicks make the
   * template card appear — the L2 arc, drivable without an ERP login.
   */
  const simulateFinopsRep = async () => {
    setDemoBusy(true);
    try {
      // Backdated an hour so several 11-minute-spaced reps land in the past.
      domainSimBaseAtMs ??= Date.now() - 60 * 60_000;
      const rep = domainSimRepIndex++;
      await emitAppEvent({ type: "simulate_pet_event", event: "OBSERVING_STARTED" });
      const result = await ingestEvents(
        finopsThreeWayRepFixture({ rep_index: rep, base_at_ms: domainSimBaseAtMs }),
        { observationPaused: settings.observation_paused },
      );
      setDemoResult(result);
      setFinopsRepCount(rep + 1);
      await emitAppEvent({ type: "simulate_pet_event", event: "OBSERVING_STOPPED" });
      await emitAppEvent({ type: "simulate_pet_event", event: "THINKING_STARTED" });
      await useRecommendations.getState().refresh();
      await emitAppEvent({ type: "simulate_pet_event", event: "THINKING_FINISHED" });
    } finally {
      setDemoBusy(false);
    }
  };

  /**
   * Simulated month-end accrual rep: one repetition of the finops
   * `month_end_accruals` PACK workflow. This is the FISCAL_MONTHLY cadence, so
   * two clicks give the Layer 5 scheduler something real to time a pre-close
   * card against (a continuous workflow has no close to count down to).
   */
  const simulateMonthEndRep = async () => {
    setDemoBusy(true);
    try {
      monthEndSimBaseAtMs ??= Date.now() - 90 * 60_000;
      const rep = monthEndSimRepIndex++;
      await emitAppEvent({ type: "simulate_pet_event", event: "OBSERVING_STARTED" });
      const result = await ingestEvents(
        finopsMonthEndRepFixture({ rep_index: rep, base_at_ms: monthEndSimBaseAtMs }),
        { observationPaused: settings.observation_paused },
      );
      setDemoResult(result);
      setMonthEndRepCount(rep + 1);
      await emitAppEvent({ type: "simulate_pet_event", event: "OBSERVING_STOPPED" });
      await emitAppEvent({ type: "simulate_pet_event", event: "THINKING_STARTED" });
      await useRecommendations.getState().refresh();
      await emitAppEvent({ type: "simulate_pet_event", event: "THINKING_FINISHED" });
    } finally {
      setDemoBusy(false);
    }
  };

  /**
   * Simulated renewal rep: one repetition of the revops `renewal_motion` PACK
   * workflow. This is the DATE_DRIVEN cadence — it fires off a term-end date read
   * from the record itself, so it exercises the observer's date extractor and the
   * local watched-date path rather than the fiscal calendar.
   */
  const simulateRenewalRep = async () => {
    setDemoBusy(true);
    try {
      renewalSimBaseAtMs ??= Date.now() - 120 * 60_000;
      const rep = renewalSimRepIndex++;
      await emitAppEvent({ type: "simulate_pet_event", event: "OBSERVING_STARTED" });
      const result = await ingestEvents(
        revopsRenewalRepFixture({ rep_index: rep, base_at_ms: renewalSimBaseAtMs }),
        { observationPaused: settings.observation_paused },
      );
      setDemoResult(result);
      setRenewalRepCount(rep + 1);
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

        {/* THE SUBTITLE BAR, TURNED OFF FROM HERE.
            It was only reachable through Settings, which is the wrong place for
            it: the bar is the thing sitting on top of the user's screen right
            now, so the decision to have it belongs next to what it is
            narrating. The same Tauri command runs either way, so the two
            controls cannot disagree about whether it is showing. */}
        <div className="mt-3 flex items-center justify-between gap-3 border-t border-line pt-3">
          <div>
            <p className="text-sm">Subtitle bar</p>
            <Muted>
              {settings.statusbar_enabled
                ? "Showing what Maman is doing, on top of your other windows."
                : "Hidden. Maman keeps observing — this only affects whether you see the bar."}
            </Muted>
          </div>
          <Button
            variant="secondary"
            onClick={() => {
              void setSubtitleBarVisible(!settings.statusbar_enabled, update).then((r) => {
                // Stated, not swallowed. If the window would not obey, the
                // preference has already been rolled back and the user needs to
                // know why the bar is still there.
                setBarError(r.ok ? null : r.detail);
              });
            }}
          >
            {settings.statusbar_enabled ? "Hide it" : "Show it"}
          </Button>
        </div>
        {barError && <p className="mt-1 text-xs text-danger">{barError}</p>}
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
          <Button variant="secondary" onClick={() => void simulateFinopsRep()} disabled={demoBusy}>
            Simulate FinOps rep{finopsRepCount > 0 ? ` (${finopsRepCount})` : ""}
          </Button>
          <Button
            variant="secondary"
            onClick={() => void simulateMonthEndRep()}
            disabled={demoBusy}
          >
            Simulate month-end rep{monthEndRepCount > 0 ? ` (${monthEndRepCount})` : ""}
          </Button>
          <Button variant="secondary" onClick={() => void simulateRenewalRep()} disabled={demoBusy}>
            Simulate renewal rep{renewalRepCount > 0 ? ` (${renewalRepCount})` : ""}
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
