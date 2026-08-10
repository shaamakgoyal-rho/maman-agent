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
import { compileAgentSpec } from "@maman/agent-runtime";
import { DEFAULT_ORG_POLICY } from "@maman/policy-engine";

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

  it("the derived intent HONESTLY refuses to compile: the data source was never observed", async () => {
    // THIS TEST USED TO PIN THE WRONG-AGENT PATHOLOGY. The live pattern is a
    // CRM edit — the user retypes two fields in Salesforce; no spreadsheet, no
    // file was ever observed. Yet `update_account_records` matched the
    // CSV→Salesforce reconciliation recipe on intent alone, so this arc
    // compiled a CSV-parsing agent demanding an `account_csv` input the user
    // never mentioned, ran it against demo rows, and the old assertions below
    // celebrated the result ("shadow → supervised → approve → applied").
    //
    // The honest behaviour: the workflow updates records, but WHERE the new
    // values come from was never seen — so compilation reports exactly that,
    // as a typed needs_configuration, instead of shipping an unrelated agent.
    const rec = result.recommendations[0]!;
    const candidate = result.candidates.find((c) => c.pattern_id === rec.pattern_id)!;
    const compile = await compileAgentSpec({
      candidate,
      generalized_intent: rec.generalized_intent!,
      desired_outcome: rec.summary,
      organization_id: "00000000-0000-7000-8000-000000000002",
      owner_user_id: OWNER,
      budgets: {
        max_runtime_seconds: 300,
        max_model_tokens: 12_000,
        max_cost_usd: 1,
        max_records_read: 1000,
        max_records_written: 20,
      },
      policy: DEFAULT_ORG_POLICY,
      policy_version_id: "00000000-0000-7000-8000-00000000p001",
      now: () => new Date("2026-08-01T11:00:00.000Z"),
    });
    expect(compile.status).toBe("needs_configuration");
    if (compile.status !== "needs_configuration") return;
    expect(compile.missing.map((m) => m.kind)).toContain("data_source");

    // And the run path surfaces the refusal as a clear failure, not a crash —
    // and NEVER as a completed run against substituted demo data.
    const runs = useRuns.getState();
    await runs.startShadow(candidate, rec.generalized_intent, rec.summary);
    const s = useRuns.getState();
    expect(s.phase).toBe("failed");
    expect(s.error).toMatch(/where the new values come from/);
    expect(s.receipt).toBeNull();
  });

  it("the EXPLICIT reconciliation demo arc still runs end to end", async () => {
    // The demo workflow really is spreadsheet→Salesforce reconciliation (both
    // halves of the evidence present), so the explicit intent still compiles
    // and the full shadow → approve → applied arc works.
    const demoCandidate = {
      pattern_id: uuidv7(),
      owner_user_id: OWNER,
      first_seen_at: "2026-07-01T09:00:00.000Z",
      last_seen_at: "2026-07-21T09:00:00.000Z",
      occurrence_count: 23,
      distinct_day_count: 12,
      median_duration_ms: 480_000,
      p90_duration_ms: 600_000,
      canonical_sequence: [
        "chrome:spreadsheet:table_read:grid:account_list:account",
        "chrome:crm:record_opened:row:account:account",
        "chrome:crm:record_updated:field:account_field:account",
      ],
      episode_ids: [],
      similarity_mean: 0.95,
      repeatability_score: 0.9,
      feasibility_score: 0.8,
      risk_score: 0.3,
      projected_minutes_saved_weekly: 64,
      opportunity_score: 0.72,
      status: "eligible" as const,
    };
    const runs = useRuns.getState();

    await runs.startShadow(demoCandidate, "reconcile_account_list", "Reconcile accounts.");
    let s = useRuns.getState();
    expect(s.phase).toBe("completed");
    expect(s.diff).not.toBeNull();
    const shadowChanges = s.diff!.summary.change_count;
    expect(shadowChanges).toBeGreaterThan(0);
    expect(s.receipt!.totals.writes_completed).toBe(0);

    await runs.startSupervised(demoCandidate, "reconcile_account_list", "Reconcile accounts.");
    s = useRuns.getState();
    expect(s.phase).toBe("waiting_approval");
    await runs.approve();
    s = useRuns.getState();
    expect(s.phase).toBe("completed");
    expect(s.receipt!.totals.writes_completed).toBe(shadowChanges);
  });
});
