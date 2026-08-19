import { describe, expect, it } from "vitest";
import {
  evaluateVerification,
  humanizeToken,
  replayAgainstTrace,
  replayCandidate,
  replayCandidateLeaveOneOut,
  type EpisodeTrace,
} from "../src/replay.js";

/**
 * Replay verification is the demo's headline claim ("tested against your last
 * N runs, matched M") — these tests pin its alignment semantics exactly.
 * Token shape: source:app_category:event_type:target_role:semantic_type:object_type
 */

const OPEN_SHEET = "macos_ax:spreadsheet:record_opened:row:open_record:account";
const EDIT_CRM = "macos_ax:crm:record_update:field:update_record:account";
const SAVE_CRM = "macos_ax:crm:record_update:save_button:save_record:account";
const EXPORT = "macos_ax:spreadsheet:table_exported:menu:export_table:account";
const NOOP_FOCUS = "macos_ax:crm:app_activated:-:-:-"; // no semantic/object → no-op

const AGENT = [OPEN_SHEET, EDIT_CRM, SAVE_CRM];

function trace(id: string, tokens: string[], started = "2026-07-30T10:00:00.000Z"): EpisodeTrace {
  return { episode_id: id, started_at: started, tokens };
}

describe("replayAgainstTrace", () => {
  it("an identical run matches", () => {
    const r = replayAgainstTrace(AGENT, trace("e1", [OPEN_SHEET, EDIT_CRM, SAVE_CRM]));
    expect(r.verdict).toBe("match");
    expect(r.aligned_steps).toBe(3);
    expect(r.divergence_step).toBeUndefined();
  });

  it("no-op noise (focus/app switches) never fails a run", () => {
    const r = replayAgainstTrace(
      AGENT,
      trace("e2", [NOOP_FOCUS, OPEN_SHEET, NOOP_FOCUS, EDIT_CRM, SAVE_CRM, NOOP_FOCUS]),
    );
    expect(r.verdict).toBe("match");
  });

  it("timing is ignored by construction (tokens carry no timing)", () => {
    // Same steps, different order of no-ops only — still a match.
    const r = replayAgainstTrace(AGENT, trace("e3", [OPEN_SHEET, EDIT_CRM, NOOP_FOCUS, SAVE_CRM]));
    expect(r.verdict).toBe("match");
  });

  it("a run that skips a mid step is partial, naming the first divergent step", () => {
    // Missing EDIT_CRM: agent step 2 diverges.
    const r = replayAgainstTrace(AGENT, trace("e4", [OPEN_SHEET, EXPORT]));
    expect(r.verdict).toBe("partial");
    expect(r.divergence_step).toBe(2);
    expect(r.aligned_steps).toBe(1);
    expect(r.expected).toMatch(/update record/);
    expect(r.observed).toMatch(/export table/);
  });

  it("a completely different run is a miss", () => {
    const r = replayAgainstTrace(AGENT, trace("e5", [EXPORT]));
    expect(r.verdict).toBe("miss");
    expect(r.divergence_step).toBe(1);
    expect(r.aligned_steps).toBe(0);
  });

  it("extra meaningful steps between agent steps do not break ordered alignment", () => {
    // Worker did an extra export mid-way; the agent's steps still appear in order.
    const r = replayAgainstTrace(AGENT, trace("e6", [OPEN_SHEET, EXPORT, EDIT_CRM, SAVE_CRM]));
    expect(r.verdict).toBe("match");
  });

  it("out-of-order meaningful steps diverge", () => {
    // Save before edit: EDIT_CRM aligns (found later)? No — SAVE appears before
    // EDIT here, so EDIT aligns at index 2... construct a real inversion:
    const r = replayAgainstTrace([EDIT_CRM, SAVE_CRM], trace("e7", [SAVE_CRM]));
    expect(r.verdict).toBe("miss");
  });
});

describe("replayCandidate", () => {
  it("tests the K most recent runs and counts matches — the card's exact numbers", () => {
    const traces: EpisodeTrace[] = [];
    for (let i = 0; i < 23; i++) {
      const day = String(i + 1).padStart(2, "0");
      // Two divergent runs land inside the most-recent window.
      const divergent = i === 20 || i === 22;
      traces.push(
        trace(
          `e${i}`,
          divergent ? [OPEN_SHEET, EXPORT] : [OPEN_SHEET, EDIT_CRM, SAVE_CRM],
          `2026-07-${day}T10:00:00.000Z`,
        ),
      );
    }
    const report = replayCandidate(AGENT, traces, 21);
    expect(report.runs_tested).toBe(21);
    expect(report.runs_matched).toBe(19);
    const divergences = report.results.filter((r) => r.verdict !== "match");
    expect(divergences).toHaveLength(2);
    expect(divergences.every((d) => d.divergence_step === 2)).toBe(true);
  });

  it("window larger than history tests everything available", () => {
    const report = replayCandidate(AGENT, [trace("a", AGENT), trace("b", AGENT)], 50);
    expect(report.runs_tested).toBe(2);
    expect(report.runs_matched).toBe(2);
  });
});

describe("humanizeToken", () => {
  it("renders card-ready plain language", () => {
    expect(humanizeToken(EDIT_CRM)).toBe("update record on account records in your CRM");
    expect(humanizeToken(EXPORT)).toBe("export table on account records in your spreadsheet");
  });
});

/**
 * COMPARISON-BASIS DEGRADATION for the primary source. The live AX observer
 * emits neither semantic_type nor object_type, so every real token ends
 * ":-:-". These tests pin that such tokens compare on (role, event_type)
 * instead of being discarded — the old isNoOp filtered BOTH sides of every
 * live comparison to zero, every fold returned insufficient_evidence, and no
 * novel pattern could ever verify at any occurrence count.
 */
describe("live AX tokens (no semantic/object) verify on the fallback basis", () => {
  const LIVE_OPEN = "macos_ax:crm:element_focused:textbox:-:-";
  const LIVE_EDIT = "macos_ax:crm:value_changed:textbox:-:-";
  const LIVE_SAVE = "macos_ax:crm:element_pressed:button:-:-";
  const PURE_NOISE = "macos_ax:crm:app_activated:-:-:-";
  const LIVE_RUN = [LIVE_OPEN, LIVE_EDIT, LIVE_SAVE];

  it("role+event tokens are meaningful steps, not no-ops", () => {
    const r = replayAgainstTrace(LIVE_RUN, trace("l1", [PURE_NOISE, ...LIVE_RUN, PURE_NOISE]));
    expect(r.verdict).toBe("match");
    expect(r.expected_steps).toBe(3);
    expect(r.aligned_steps).toBe(3);
  });

  it("the fallback basis still detects divergence (different role/event)", () => {
    const r = replayAgainstTrace(
      LIVE_RUN,
      trace("l2", [LIVE_OPEN, "macos_ax:crm:element_pressed:link:-:-"]),
    );
    expect(r.verdict).toBe("partial");
    expect(r.divergence_step).toBe(2);
  });

  it("≥5 live-shaped episodes reach verified: true under leave-one-out", () => {
    const traces = Array.from({ length: 5 }, (_, i) =>
      trace(`l${i}`, LIVE_RUN, `2026-07-3${0 + (i % 2)}T1${i}:00:00.000Z`),
    );
    const report = replayCandidateLeaveOneOut(traces, (training) => training[0]!.tokens, 21);
    expect(report.runs_tested - report.runs_insufficient).toBe(5);
    expect(report.meaningful_expected_steps).toBe(3);
    const outcome = evaluateVerification(report, { min_runs: 5, min_match_pct: 0.85 });
    expect(outcome).toEqual({ verified: true });
  });

  it("pure-noise tokens (no role either) still refuse as insufficient", () => {
    const noise = [PURE_NOISE, PURE_NOISE, PURE_NOISE];
    const traces = Array.from({ length: 5 }, (_, i) =>
      trace(`n${i}`, noise, `2026-07-30T1${i}:00:00.000Z`),
    );
    const report = replayCandidateLeaveOneOut(traces, (training) => training[0]!.tokens, 21);
    expect(report.runs_insufficient).toBe(5);
    expect(report.meaningful_expected_steps).toBe(0);
    const outcome = evaluateVerification(report, { min_runs: 5, min_match_pct: 0.85 });
    expect(outcome.verified).toBe(false);
  });

  it("a semantic step never equals a fallback step of the same role", () => {
    // Same role "field", but one side carries semantics and the other does not:
    // the two bases must not cross-match.
    const semantic = ["macos_ax:crm:record_update:textbox:update_record:account"];
    const r = replayAgainstTrace(semantic, trace("x1", ["macos_ax:crm:record_update:textbox:-:-"]));
    expect(r.verdict).toBe("miss");
  });
});
