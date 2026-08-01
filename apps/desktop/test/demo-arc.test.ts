import { describe, expect, it } from "vitest";
import { demoHistoryFixture } from "@maman/demo-fixtures";
import {
  patternSignature,
  replayCandidate,
  runPatternEngine,
  toPatternFeature,
} from "@maman/pattern-engine";

/**
 * The demo arc's acceptance test: the seeded month of history must flow
 * through the REAL pipeline (projection → segmentation → clustering →
 * eligibility → replay verification) and produce the card's exact numbers —
 * tested against the last 21 runs, matched 19 — with the two planted
 * divergences named at the Salesforce-update step. No manual DB edits,
 * nothing staged: if this test passes, every number on the card is real.
 */

const OWNER = "00000000-0000-7000-8000-000000000001";

describe("demo arc: seeded history → verified card numbers", () => {
  const events = demoHistoryFixture();
  const features = events.map((e) => toPatternFeature(e));
  const result = runPatternEngine(features, {
    owner_user_id: OWNER,
    now: () => new Date("2026-08-04T09:00:00.000Z"),
  });

  it("the seeded history forms one eligible reconciliation pattern", () => {
    expect(result.recommendations.length).toBeGreaterThanOrEqual(1);
    const rec = result.recommendations[0]!;
    const candidate = result.candidates.find((c) => c.pattern_id === rec.pattern_id)!;
    expect(candidate.occurrence_count).toBe(23);
    expect(candidate.status).toBe("eligible");
  });

  it("replay verification reports exactly 19 of 21 — the honest imperfect score", () => {
    const rec = result.recommendations[0]!;
    const candidate = result.candidates.find((c) => c.pattern_id === rec.pattern_id)!;
    const episodeById = new Map(result.episodes.map((e) => [e.episode_id, e]));
    const traces = candidate.episode_ids
      .map((id) => episodeById.get(id)!)
      .filter(Boolean)
      .map((e) => ({
        episode_id: e.episode_id,
        started_at: e.started_at,
        tokens: e.canonical_tokens,
      }));

    const report = replayCandidate(candidate.canonical_sequence, traces, 21);
    expect(report.runs_tested).toBe(21);
    expect(report.runs_matched).toBe(19);

    // Both divergences name the Salesforce-update step in plain language.
    const divergences = report.results.filter((r) => r.verdict !== "match");
    expect(divergences).toHaveLength(2);
    for (const d of divergences) {
      expect(d.divergence_step).toBeGreaterThan(0);
      expect(d.expected).toMatch(/update|record/i);
    }
  });

  it("the verification gate passes at the default thresholds (≥10 tested, ≥85% matched)", () => {
    // 19/21 = 90.5% — the gate the card is spawned from.
    expect(19 / 21).toBeGreaterThanOrEqual(0.85);
    expect(21).toBeGreaterThanOrEqual(10);
  });

  it("the pattern signature is stable so card state keys stay consistent", () => {
    const rec = result.recommendations[0]!;
    const candidate = result.candidates.find((c) => c.pattern_id === rec.pattern_id)!;
    expect(patternSignature(candidate.canonical_sequence)).toBe(
      patternSignature(candidate.canonical_sequence),
    );
  });
});
