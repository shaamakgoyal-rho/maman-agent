import { describe, expect, it } from "vitest";
import {
  candidatePairs,
  clusterEpisodes,
  passesSanityChecks,
  sequenceSimilarity,
  substitutionCost,
} from "../src/similarity.js";

const T = {
  sfOpen: "chrome:crm:record_opened:row:account:account",
  sfOpenBtn: "chrome:crm:record_opened:button:account:account",
  sfUpdate: "chrome:crm:record_updated:field:account:account",
  sheetRead: "chrome:spreadsheet:table_read:grid:account_list:account",
  sheetEdit: "chrome:spreadsheet:value_committed:cell:company_domain:account",
  slack: "chrome:other:navigation:-:channel:-",
};

describe("substitution weights (locked)", () => {
  it("identical tokens cost 0", () => {
    expect(substitutionCost(T.sfOpen, T.sfOpen)).toBe(0);
  });

  it("same app and event type, different role costs 0.25", () => {
    expect(substitutionCost(T.sfOpen, T.sfOpenBtn)).toBe(0.25);
  });

  it("same app, different event type costs 0.60", () => {
    expect(substitutionCost(T.sfOpen, T.sfUpdate)).toBe(0.6);
  });

  it("different app, semantically equivalent action costs 0.50", () => {
    const sheetsOpen = "chrome:spreadsheet:record_opened:row:account:account";
    expect(substitutionCost(T.sfOpen, sheetsOpen)).toBe(0.5);
  });

  it("unrelated events cost 1.00", () => {
    expect(substitutionCost(T.sfOpen, T.slack)).toBe(1);
  });
});

describe("sequence similarity", () => {
  const base = [T.sheetRead, T.sheetEdit, T.sfOpen, T.sfUpdate];

  it("identical sequences score 1", () => {
    expect(sequenceSimilarity(base, [...base])).toBe(1);
  });

  it("similar sequences with one optional step stay above threshold", () => {
    // Realistic workflow length (like the fixture): one optional extra step.
    const long = [...base, T.sheetRead, T.sfOpen, T.sheetEdit, T.sfUpdate];
    const withOptional = [...long.slice(0, 3), T.sheetEdit, ...long.slice(3)];
    expect(sequenceSimilarity(long, withOptional)).toBeGreaterThan(0.82);
  });

  it("reordered steps reduce similarity but stay related", () => {
    const reordered = [T.sheetEdit, T.sheetRead, T.sfOpen, T.sfUpdate];
    const similarity = sequenceSimilarity(base, reordered);
    expect(similarity).toBeLessThan(1);
    expect(similarity).toBeGreaterThan(0.5);
  });

  it("unrelated workflows score low", () => {
    const unrelated = [
      T.slack,
      "chrome:other:record_opened:-:profile:-",
      "chrome:calendar:element_activated:-:event:-",
    ];
    expect(sequenceSimilarity(base, unrelated)).toBeLessThan(0.4);
  });

  it("empty sequences are handled", () => {
    expect(sequenceSimilarity([], [])).toBe(1);
    expect(sequenceSimilarity(base, [])).toBe(0);
  });

  it("duplicate events do not inflate similarity to unrelated sequences", () => {
    const dupes = [T.slack, T.slack, T.slack, T.slack];
    expect(sequenceSimilarity(base, dupes)).toBeLessThan(0.3);
  });
});

describe("MinHash/LSH candidate pairs", () => {
  it("finds identical and near-identical sequences as candidates", () => {
    const sequences = [
      [T.sheetRead, T.sheetEdit, T.sfOpen, T.sfUpdate],
      [T.sheetRead, T.sheetEdit, T.sfOpen, T.sfUpdate],
      [T.slack, "chrome:other:record_opened:-:profile:-"],
    ];
    const pairs = candidatePairs(sequences);
    expect(pairs).toContainEqual([0, 1]);
    expect(pairs).not.toContainEqual([0, 2]);
    expect(pairs).not.toContainEqual([1, 2]);
  });
});

describe("sanity checks", () => {
  const mk = (ms: number, apps: string[]) => ({
    tokens: [],
    active_duration_ms: ms,
    app_categories: apps,
  });

  it("rejects durations more than 3x apart (long idle inflation)", () => {
    expect(passesSanityChecks(mk(60_000, ["crm"]), mk(200_000, ["crm"]))).toBe(false);
    expect(passesSanityChecks(mk(60_000, ["crm"]), mk(170_000, ["crm"]))).toBe(true);
  });

  it("requires app-category overlap", () => {
    expect(passesSanityChecks(mk(60_000, ["crm"]), mk(60_000, ["email"]))).toBe(false);
    expect(
      passesSanityChecks(mk(60_000, ["crm", "spreadsheet"]), mk(60_000, ["crm", "spreadsheet"])),
    ).toBe(true);
  });
});

describe("complete-linkage clustering", () => {
  it("clusters similar episodes and isolates unrelated ones", () => {
    const a = {
      tokens: [T.sheetRead, T.sheetEdit, T.sfOpen, T.sfUpdate],
      active_duration_ms: 600_000,
      app_categories: ["spreadsheet", "crm"],
    };
    const b = { ...a, tokens: [T.sheetRead, T.sheetEdit, T.sfOpen, T.sfUpdate] };
    const c = {
      tokens: [T.slack, "chrome:other:record_opened:-:profile:-", T.slack],
      active_duration_ms: 300_000,
      app_categories: ["other"],
    };
    const clusters = clusterEpisodes([a, b, c], 0.82);
    const sizes = clusters.map((cl) => cl.members.length).sort();
    expect(sizes).toEqual([1, 2]);
    const pair = clusters.find((cl) => cl.members.length === 2)!;
    expect(pair.similarity_mean).toBeGreaterThanOrEqual(0.82);
  });

  it("threshold boundary: exactly at threshold clusters, just below does not", () => {
    // Construct sequences with a known similarity: one substitution 0.25 over
    // 5 tokens → distance 0.25, max 5*0.7=3.5 → sim ≈ 0.9286
    const base = [T.sheetRead, T.sheetEdit, T.sfOpen, T.sfUpdate, T.sheetRead];
    const variant = [T.sheetRead, T.sheetEdit, T.sfOpenBtn, T.sfUpdate, T.sheetRead];
    const sim = sequenceSimilarity(base, variant);
    const a = { tokens: base, active_duration_ms: 600_000, app_categories: ["spreadsheet", "crm"] };
    const b = {
      tokens: variant,
      active_duration_ms: 600_000,
      app_categories: ["spreadsheet", "crm"],
    };
    // exactly at the computed similarity → clusters
    expect(clusterEpisodes([a, b], sim).some((c) => c.members.length === 2)).toBe(true);
    // infinitesimally above → does not cluster
    expect(clusterEpisodes([a, b], sim + 1e-9).every((c) => c.members.length === 1)).toBe(true);
  });
});
