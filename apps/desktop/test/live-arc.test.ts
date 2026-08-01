import { describe, expect, it } from "vitest";
import { uuidv7, workflowEventSchema, type WorkflowEvent } from "@maman/contracts";
import {
  effectiveEligibility,
  replayCandidate,
  runPatternEngine,
  toPatternFeature,
} from "@maman/pattern-engine";
import { DETECTION_LIVE_DEMO } from "../src/state/settings.js";
import { useRuns } from "../src/lib/runs.js";

/**
 * The LIVE demo arc's acceptance test: events shaped exactly like the live
 * browser relay emits them — point-in-time (no duration_ms), field commits as
 * value_committed, context derived from the page URL — repeated four times
 * back-to-back in ONE sitting, must flow through the real pipeline under the
 * Live-demo preset and produce a suggestion whose derived intent compiles and
 * executes: shadow (zero writes) → supervised → approval → applied write —
 * with the demo world persisting across runs so the second look shows the
 * work is already done.
 */

const OWNER = "00000000-0000-7000-8000-000000000001";
const START = Date.parse("2026-08-01T10:00:00.000Z");
const STEP_GAP_MS = 40_000;
const REP_GAP_MS = 50_000;

type LiveStep = {
  event_type: WorkflowEvent["event_type"];
  role?: string;
  semantic_type?: string;
  object_type?: string;
  page_type?: string;
};

// One repetition of a live Salesforce edit workflow, as the relay records it.
const LIVE_STEPS: LiveStep[] = [
  { event_type: "navigation", object_type: "account", page_type: "record" },
  { event_type: "element_activated", role: "searchbox", object_type: "account" },
  {
    event_type: "value_committed",
    role: "input",
    semantic_type: "account_name",
    object_type: "account",
  },
  {
    event_type: "value_committed",
    role: "input",
    semantic_type: "account_phone",
    object_type: "account",
  },
];

function liveEvents(reps: number): WorkflowEvent[] {
  const events: WorkflowEvent[] = [];
  let t = START;
  let monotonic = 1000;
  for (let rep = 0; rep < reps; rep++) {
    for (const s of LIVE_STEPS) {
      events.push(
        workflowEventSchema.parse({
          schema_version: 1,
          event_id: uuidv7({ timestampMs: t }),
          device_id: uuidv7(),
          user_id: OWNER,
          organization_id: "00000000-0000-7000-8000-000000000002",
          occurred_at: new Date(t).toISOString(),
          monotonic_ms: monotonic,
          source: "chrome",
          app: { display_name: "Salesforce", domain: "acme.lightning.force.com" },
          event_type: s.event_type,
          target: {
            ...(s.role ? { role: s.role } : {}),
            ...(s.semantic_type ? { semantic_type: s.semantic_type } : {}),
            stable_id_hash: `h_${s.event_type}_${s.role ?? "none"}`,
          },
          context: {
            ...(s.page_type ? { page_type: s.page_type } : {}),
            ...(s.object_type ? { object_type: s.object_type } : {}),
          },
          // No duration_ms: live sources emit point-in-time events.
          sensitivity: "internal",
          redaction: { applied: false, reasons: [] },
        } satisfies WorkflowEvent),
      );
      t += STEP_GAP_MS;
      monotonic += STEP_GAP_MS;
    }
    t += REP_GAP_MS;
    monotonic += REP_GAP_MS;
  }
  return events;
}

const liveEngineOptions = {
  owner_user_id: OWNER,
  now: () => new Date("2026-08-01T11:00:00.000Z"),
  eligibility: effectiveEligibility({
    min_occurrences: DETECTION_LIVE_DEMO.detect_min_occurrences,
    min_distinct_days: DETECTION_LIVE_DEMO.detect_min_distinct_days,
    min_projected_minutes_weekly: DETECTION_LIVE_DEMO.detect_min_projected_minutes_weekly,
  }),
  opportunity_threshold: DETECTION_LIVE_DEMO.detect_opportunity_threshold,
  segmentation: {
    event_gap_boundary_ms: DETECTION_LIVE_DEMO.detect_event_gap_boundary_s * 1000,
    split_on_sequence_restart: DETECTION_LIVE_DEMO.detect_split_on_sequence_restart,
  },
};

describe("live arc: same-day repetitions → suggestion → executed run", () => {
  const features = liveEvents(4).map((e) => toPatternFeature(e));
  const result = runPatternEngine(features, liveEngineOptions);

  it("four back-to-back live repetitions segment into four episodes", () => {
    expect(result.episodes.length).toBe(4);
    for (const e of result.episodes) {
      expect(e.active_duration_ms).toBeGreaterThanOrEqual(10_000);
      expect(e.canonical_tokens.length).toBe(LIVE_STEPS.length);
    }
  });

  it("the live pattern is eligible and surfaces under the Live-demo preset", () => {
    expect(result.recommendations.length).toBe(1);
    const candidate = result.candidates.find(
      (c) => c.pattern_id === result.recommendations[0]!.pattern_id,
    )!;
    expect(candidate.status).toBe("eligible");
    expect(candidate.occurrence_count).toBe(4);
    expect(candidate.distinct_day_count).toBe(1);
  });

  it("naming derives the executable intent from the live pattern", () => {
    const rec = result.recommendations[0]!;
    expect(rec.generalized_intent).toBe("update_account_records");
    expect(rec.title).toMatch(/account/i);
  });

  it("under PRODUCTION bars the same pattern only forms, never surfaces", () => {
    const prod = runPatternEngine(features, {
      owner_user_id: OWNER,
      now: () => new Date("2026-08-01T11:00:00.000Z"),
    });
    expect(prod.recommendations).toEqual([]);
  });

  it("replay verification clears the live-demo gate (4 of 4, ≥3 required)", () => {
    const rec = result.recommendations[0]!;
    const candidate = result.candidates.find((c) => c.pattern_id === rec.pattern_id)!;
    const episodeById = new Map(result.episodes.map((e) => [e.episode_id, e]));
    const traces = candidate.episode_ids
      .map((id) => episodeById.get(id)!)
      .map((e) => ({
        episode_id: e.episode_id,
        started_at: e.started_at,
        tokens: e.canonical_tokens,
      }));
    const report = replayCandidate(candidate.canonical_sequence, traces, 21);
    expect(report.runs_tested).toBe(4);
    expect(report.runs_tested).toBeGreaterThanOrEqual(DETECTION_LIVE_DEMO.verify_min_runs);
    expect(report.runs_matched / report.runs_tested).toBeGreaterThanOrEqual(0.85);
  });

  it("the derived intent compiles and runs: shadow → supervised → approve → applied", async () => {
    const rec = result.recommendations[0]!;
    const candidate = result.candidates.find((c) => c.pattern_id === rec.pattern_id)!;
    const runs = useRuns.getState();

    // Shadow: full read path, a real proposed diff, zero writes.
    await runs.startShadow(candidate, rec.generalized_intent, rec.summary);
    let s = useRuns.getState();
    expect(s.phase).toBe("completed");
    expect(s.diff).not.toBeNull();
    const shadowChanges = s.diff!.summary.change_count;
    expect(shadowChanges).toBeGreaterThan(0);
    expect(s.receipt!.totals.writes_completed).toBe(0);

    // Supervised: pauses at the approval gate, applies only after approval.
    await runs.startSupervised(candidate, rec.generalized_intent, rec.summary);
    s = useRuns.getState();
    expect(s.phase).toBe("waiting_approval");
    expect(s.pending).not.toBeNull();
    await runs.approve();
    s = useRuns.getState();
    expect(s.phase).toBe("completed");
    expect(s.receipt!.totals.writes_completed).toBe(shadowChanges);

    // The demo world persisted: a fresh shadow now finds nothing left to change.
    await runs.startShadow(candidate, rec.generalized_intent, rec.summary);
    s = useRuns.getState();
    expect(s.phase).toBe("completed");
    expect(s.diff!.summary.change_count).toBeLessThan(shadowChanges);
  });
});
