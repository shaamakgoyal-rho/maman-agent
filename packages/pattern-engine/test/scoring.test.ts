import { describe, expect, it } from "vitest";
import {
  clamp01,
  errorReductionScore,
  feasibilityScore,
  median,
  percentile,
  riskScore,
} from "../src/scoring.js";

describe("statistics helpers", () => {
  it("median of odd and even sets", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBe(0);
  });

  it("p90 percentile", () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(percentile([5], 90)).toBe(5);
  });

  it("clamp01", () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(2)).toBe(1);
  });
});

describe("feasibility", () => {
  it("fully mapped read sequences score high", () => {
    const seq = [
      "chrome:spreadsheet:table_read:grid:list:account",
      "chrome:crm:table_read:table:fields:account",
      "chrome:crm:record_opened:row:account:account",
    ];
    expect(feasibilityScore(seq)).toBeGreaterThan(0.9);
  });

  it("UI-only write steps are penalized 0.15 each", () => {
    const mapped = ["chrome:crm:table_read:table:fields:account"];
    const withUiWrite = [...mapped, "chrome:email:value_committed:cell:x:message"]; // unmapped write
    const base = feasibilityScore(mapped);
    const penalized = feasibilityScore(withUiWrite);
    expect(penalized).toBeCloseTo(Math.max(0, base / 2 - 0.15) + 0, 1);
    expect(penalized).toBeLessThan(base);
  });

  it("empty sequences are infeasible", () => {
    expect(feasibilityScore([])).toBe(0);
  });
});

describe("risk", () => {
  it("read-only sequences are low risk", () => {
    expect(
      riskScore([
        "chrome:crm:table_read:table:fields:account",
        "chrome:spreadsheet:table_read:grid:list:account",
      ]),
    ).toBeLessThan(0.3);
  });

  it("write-heavy sequences carry more risk", () => {
    const readOnly = riskScore(["chrome:crm:table_read:table:fields:account"]);
    const writey = riskScore([
      "chrome:crm:record_updated:field:account_field:account",
      "chrome:crm:record_updated:field:account_field:account",
    ]);
    expect(writey).toBeGreaterThan(readOnly);
  });
});

describe("error reduction", () => {
  it("copy/paste/rekey-heavy sequences score higher", () => {
    const heavy = errorReductionScore([
      "chrome:crm:copy_semantic:field:x:account",
      "chrome:spreadsheet:paste_semantic:cell:x:account",
      "chrome:spreadsheet:value_committed:cell:x:account",
    ]);
    const light = errorReductionScore(["chrome:crm:table_read:table:x:account"]);
    expect(heavy).toBeGreaterThan(light);
  });
});
