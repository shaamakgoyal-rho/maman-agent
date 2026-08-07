import { describe, expect, it } from "vitest";
import {
  evaluateVerification,
  replayAgainstTrace,
  replayCandidate,
  replayCandidateLeaveOneOut,
  type EpisodeTrace,
} from "../src/replay.js";
import { representativeSequence } from "../src/scoring.js";

/**
 * THE FALSE-VERIFICATION REGRESSION.
 *
 * `replayAgainstTrace` filters out steps carrying neither semantic_type nor
 * object_type as "no-op noise". On the first real device EVERY observed token
 * was of that shape, so the agent side filtered down to nothing, the alignment
 * loop never executed, and the function fell through to
 * `{verdict: "match", aligned_steps: 0}` — for any trace whatsoever, including
 * an unrelated one and an empty one.
 *
 * The user was shown "I tested it against your last 21 runs and matched 21"
 * and a "verified" badge, on the strength of 21 comparisons of nothing.
 *
 * These tests make that outcome unreachable.
 */

/** The live device's pattern 019fc4d0 — every token lacks semantic AND object. */
const NOTHING_SPECIFIC = [
  "macos_ax:browser:element_focused:AXGroup:-:-",
  "macos_ax:browser:value_committed:AXStaticText:-:-",
  "macos_ax:browser:value_committed:AXTextField:-:-",
];

/** A sequence with real semantic/object information — genuinely comparable. */
const MEANINGFUL = [
  "chrome:crm:record_opened:row:account:account",
  "chrome:crm:record_updated:field:account_field:account",
];

const trace = (id: string, tokens: string[], at = "2026-08-05T10:00:00.000Z"): EpisodeTrace => ({
  episode_id: id,
  started_at: at,
  tokens,
});

const GATE = { min_runs: 3, min_match_pct: 0.85 };

describe("a comparison of nothing is never a match", () => {
  it("returns insufficient_evidence when the agent has no executable steps", () => {
    const r = replayAgainstTrace(NOTHING_SPECIFIC, trace("e1", NOTHING_SPECIFIC));
    expect(r.verdict).toBe("insufficient_evidence");
    expect(r.expected_steps).toBe(0);
    expect(r.insufficiency_reason).toBeTruthy();
  });

  it("no longer 'matches' a completely unrelated trace", () => {
    // The exact pathology: before the fix this returned verdict "match".
    const r = replayAgainstTrace(
      NOTHING_SPECIFIC,
      trace("e2", ["chrome:email:navigation:row:compose:message"]),
    );
    expect(r.verdict).not.toBe("match");
  });

  it("no longer 'matches' an empty trace", () => {
    const r = replayAgainstTrace(MEANINGFUL, trace("e3", []));
    expect(r.verdict).toBe("insufficient_evidence");
  });

  it("a zero-step agent can never be a match, for any trace", () => {
    for (const tokens of [[], NOTHING_SPECIFIC, MEANINGFUL, ["x:y:z:-:-:-"]]) {
      expect(replayAgainstTrace([], trace("e", tokens)).verdict).toBe("insufficient_evidence");
    }
  });

  it("THE INVARIANT: no result may ever pair verdict 'match' with zero steps", () => {
    const sequences = [[], NOTHING_SPECIFIC, MEANINGFUL];
    const traces = [[], NOTHING_SPECIFIC, MEANINGFUL, ["chrome:email:navigation:row:a:b"]];
    for (const seq of sequences) {
      for (const tokens of traces) {
        const r = replayAgainstTrace(seq, trace("e", tokens));
        if (r.verdict === "match") {
          expect(r.aligned_steps).toBeGreaterThan(0);
          expect(r.expected_steps).toBeGreaterThan(0);
        }
      }
    }
  });

  it("still matches, and counts steps, when the comparison is real", () => {
    const r = replayAgainstTrace(MEANINGFUL, trace("e4", MEANINGFUL));
    expect(r.verdict).toBe("match");
    expect(r.aligned_steps).toBe(2);
    expect(r.expected_steps).toBe(2);
  });

  it("counts one meaningful aligned step as a real, reportable alignment", () => {
    const oneMeaningful = ["chrome:crm:record_opened:row:account:account"];
    const r = replayAgainstTrace(oneMeaningful, trace("e5", MEANINGFUL));
    expect(r.verdict).toBe("match");
    expect(r.aligned_steps).toBe(1);
  });

  it("reports mismatched executable behaviour as a divergence, not a pass", () => {
    const r = replayAgainstTrace(
      MEANINGFUL,
      trace("e6", ["chrome:crm:record_opened:row:account:account", "chrome:email:send:row:a:b"]),
    );
    expect(r.verdict).toBe("partial");
    expect(r.aligned_steps).toBe(1);
    expect(r.divergence_step).toBe(2);
  });
});

describe("training and validation runs are separated", () => {
  it("labels a fixed-sequence replay self_referential, since it cannot know better", () => {
    const report = replayCandidate(MEANINGFUL, [trace("a", MEANINGFUL)], 21);
    expect(report.validation_method).toBe("self_referential");
  });

  it("derives the tested sequence from the OTHER runs under leave-one-out", () => {
    const traces = [
      trace("a", MEANINGFUL, "2026-08-01T10:00:00.000Z"),
      trace("b", MEANINGFUL, "2026-08-02T10:00:00.000Z"),
      trace("c", MEANINGFUL, "2026-08-03T10:00:00.000Z"),
    ];
    const seen: string[][] = [];
    const report = replayCandidateLeaveOneOut(
      traces,
      (training) => {
        seen.push(training.map((t) => t.episode_id));
        return representativeSequence(
          training.map((t) => ({ canonical_tokens: t.tokens }) as never),
        );
      },
      21,
    );
    expect(report.validation_method).toBe("leave_one_out");
    // Every fold trained on exactly the other two runs — never on the held-out one.
    expect(seen).toHaveLength(3);
    for (const [i, ids] of seen.entries()) {
      expect(ids).toHaveLength(2);
      expect(ids).not.toContain(report.results[i]!.episode_id);
    }
    expect(report.runs_matched).toBe(3);
  });

  it("cannot split a single run into train and test", () => {
    const report = replayCandidateLeaveOneOut([trace("a", MEANINGFUL)], () => MEANINGFUL, 21);
    expect(report.runs_tested).toBe(1);
    expect(report.runs_insufficient).toBe(1);
    expect(report.runs_matched).toBe(0);
  });
});

describe("the verified badge requirements", () => {
  const meaningfulReport = (over: Partial<ReturnType<typeof replayCandidate>> = {}) => ({
    ...replayCandidate(
      MEANINGFUL,
      [
        trace("a", MEANINGFUL, "2026-08-01T10:00:00.000Z"),
        trace("b", MEANINGFUL, "2026-08-02T10:00:00.000Z"),
        trace("c", MEANINGFUL, "2026-08-03T10:00:00.000Z"),
      ],
      21,
      "leave_one_out",
    ),
    ...over,
  });

  it("refuses to verify when there are no meaningful expected steps", () => {
    const report = replayCandidate(
      NOTHING_SPECIFIC,
      [trace("a", NOTHING_SPECIFIC)],
      21,
      "leave_one_out",
    );
    const outcome = evaluateVerification(report, GATE);
    expect(outcome.verified).toBe(false);
    expect(outcome.reason).toMatch(/executable steps/);
  });

  it("refuses to verify a self-referential report even at a perfect score", () => {
    const report = meaningfulReport({ validation_method: "self_referential" });
    expect(report.runs_matched).toBe(3); // a "perfect" score…
    const outcome = evaluateVerification(report, GATE);
    expect(outcome.verified).toBe(false); // …that still proves nothing.
    expect(outcome.reason).toMatch(/learned from/);
  });

  it("refuses to verify without enough usable runs", () => {
    const report = replayCandidate(
      MEANINGFUL,
      [trace("a", MEANINGFUL), trace("b", MEANINGFUL)],
      21,
      "leave_one_out",
    );
    expect(evaluateVerification(report, GATE).verified).toBe(false);
  });

  it("does not count insufficient-evidence runs toward the run requirement", () => {
    const report = replayCandidate(
      MEANINGFUL,
      [trace("a", MEANINGFUL), trace("b", []), trace("c", []), trace("d", [])],
      21,
      "leave_one_out",
    );
    expect(report.runs_insufficient).toBe(3);
    const outcome = evaluateVerification(report, GATE);
    expect(outcome.verified).toBe(false);
    expect(outcome.reason).toMatch(/1 usable run/);
  });

  it("refuses to verify when an unresolved capability remains", () => {
    const outcome = evaluateVerification(meaningfulReport(), GATE, {
      unresolved_capabilities: ["browser.supervised_form_fill"],
    });
    expect(outcome.verified).toBe(false);
    expect(outcome.reason).toContain("browser.supervised_form_fill");
  });

  it("refuses to verify when a required input is missing", () => {
    const outcome = evaluateVerification(meaningfulReport(), GATE, {
      missing_inputs: ["account_csv"],
    });
    expect(outcome.verified).toBe(false);
    expect(outcome.reason).toContain("account_csv");
  });

  it("verifies only when every requirement is met at once", () => {
    const outcome = evaluateVerification(meaningfulReport(), GATE);
    expect(outcome.verified).toBe(true);
    expect(outcome.reason).toBeUndefined();
  });

  it("gives a plain-language reason whenever it refuses", () => {
    const refusals = [
      evaluateVerification(
        replayCandidate(NOTHING_SPECIFIC, [trace("a", NOTHING_SPECIFIC)], 21, "leave_one_out"),
        GATE,
      ),
      evaluateVerification(meaningfulReport({ validation_method: "self_referential" }), GATE),
      evaluateVerification(meaningfulReport(), GATE, { missing_inputs: ["x"] }),
    ];
    for (const r of refusals) {
      expect(r.verified).toBe(false);
      expect(r.reason && r.reason.length > 10).toBe(true);
    }
  });
});
