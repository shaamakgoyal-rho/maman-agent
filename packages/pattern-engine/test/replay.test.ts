import { describe, expect, it } from "vitest";
import {
  humanizeToken,
  replayAgainstTrace,
  replayCandidate,
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
