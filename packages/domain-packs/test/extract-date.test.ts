import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DATE_CONFIDENCE_FLOOR,
  extractDateIso,
  usableDate,
  type DateExtraction,
} from "../src/index.js";

/**
 * The property that matters: an ambiguous date is never resolved by guessing.
 * A renewal card fired for the wrong month is worse than no card at all, so
 * every read that cannot be pinned down must land below the usable floor.
 */

describe("unambiguous forms", () => {
  it("reads a year-first date with high confidence", () => {
    const r = extractDateIso("Term end 2026-08-25");
    expect(r.date).toBe("2026-08-25");
    expect(r.confidence).toBeGreaterThanOrEqual(DATE_CONFIDENCE_FLOOR);
  });

  it("accepts slash and dot separators in year-first order", () => {
    expect(extractDateIso("expires 2026/08/25").date).toBe("2026-08-25");
    expect(extractDateIso("expires 2026.08.25").date).toBe("2026-08-25");
  });

  it("reads month names in either order", () => {
    expect(extractDateIso("Renewal: 25 Aug 2026").date).toBe("2026-08-25");
    expect(extractDateIso("Renewal: 25 August, 2026").date).toBe("2026-08-25");
    expect(extractDateIso("Renewal: Aug 25, 2026").date).toBe("2026-08-25");
    expect(extractDateIso("Renewal: August 25 2026").date).toBe("2026-08-25");
    expect(extractDateIso("Renewal: Sept 1, 2026").date).toBe("2026-09-01");
  });

  it("handles ordinal suffixes", () => {
    expect(extractDateIso("term end Aug 25th, 2026").date).toBe("2026-08-25");
  });

  it("pads single-digit months and days", () => {
    expect(extractDateIso("2026-1-5").date).toBe("2026-01-05");
  });
});

describe("bare numeric dates", () => {
  it("is usable when one component exceeds 12 and fixes the order", () => {
    const dayFirst = extractDateIso("expires 25/08/2026");
    expect(dayFirst.date).toBe("2026-08-25");
    expect(usableDate(dayFirst).date).toBe("2026-08-25");

    const monthFirst = extractDateIso("expires 08/25/2026");
    expect(monthFirst.date).toBe("2026-08-25");
    expect(usableDate(monthFirst).date).toBe("2026-08-25");
  });

  it("REFUSES to resolve an ambiguous order, and says why", () => {
    // 3 April or 4 March? There is no honest way to choose.
    const r = extractDateIso("expires 03/04/2026");
    expect(r.confidence).toBeLessThan(DATE_CONFIDENCE_FLOOR);
    expect(usableDate(r)).toEqual({ date: null, reason: "low_confidence" });
  });

  it("treats a two-digit year as a guess about the century", () => {
    const r = extractDateIso("expires 25/08/26");
    expect(r.date).toBe("2026-08-25"); // read, but…
    expect(r.confidence).toBeLessThan(DATE_CONFIDENCE_FLOOR); // …not acted on
    expect(usableDate(r).date).toBeNull();
  });
});

describe("bad input yields nothing, never a fallback", () => {
  it("returns null for text with no date", () => {
    for (const t of ["", "Invoice INV-2041", "amount due", "renewal"]) {
      expect(extractDateIso(t)).toEqual({ date: null, confidence: 0 });
    }
  });

  it("returns null for null/undefined", () => {
    expect(extractDateIso(undefined).date).toBeNull();
    expect(extractDateIso(null).date).toBeNull();
  });

  it("rejects impossible calendar dates rather than clamping them", () => {
    expect(extractDateIso("2026-02-30").date).toBeNull();
    expect(extractDateIso("2026-13-01").date).toBeNull();
    expect(extractDateIso("31/02/2026").date).toBeNull();
    expect(extractDateIso("Feb 30, 2026").date).toBeNull();
  });

  it("accepts a real leap day and rejects a fake one", () => {
    expect(extractDateIso("2028-02-29").date).toBe("2028-02-29");
    expect(extractDateIso("2027-02-29").date).toBeNull();
  });

  it("refuses implausible years instead of scheduling centuries out", () => {
    expect(extractDateIso("1889-08-25").date).toBeNull();
    expect(extractDateIso("2999-08-25").date).toBeNull();
  });

  it("does not mistake a non-month word for a month", () => {
    expect(extractDateIso("25 Renewal 2026").date).toBeNull();
    expect(extractDateIso("Quarter 3, 2026").date).toBeNull();
  });

  it("does not read a bare number, a year alone, or an invoice id as a date", () => {
    expect(extractDateIso("INV-2041").date).toBeNull();
    expect(extractDateIso("2026").date).toBeNull();
    expect(extractDateIso("$4,500.00").date).toBeNull();
  });
});

describe("multiple candidates lower confidence", () => {
  it("penalizes a label containing more than one date", () => {
    const single = extractDateIso("term end 2026-08-25");
    const double = extractDateIso("start 2026-01-01 term end 2026-08-25");
    expect(double.confidence).toBeLessThan(single.confidence);
    // Still readable — year-first at 0.95 minus the penalty clears the floor.
    expect(usableDate(double).date).toBe("2026-01-01");
  });

  it("can push a weaker form below the floor entirely", () => {
    // Two bare-numeric dates: order-resolved but doubly uncertain.
    const r = extractDateIso("25/08/2026 and 26/09/2026");
    expect(r.confidence).toBeLessThan(DATE_CONFIDENCE_FLOOR);
    expect(usableDate(r).date).toBeNull();
  });
});

describe("usableDate is the only gate", () => {
  it("reports unreadable separately from low confidence", () => {
    expect(usableDate({ date: null, confidence: 0 })).toEqual({
      date: null,
      reason: "unreadable",
    });
    expect(usableDate({ date: "2026-08-25", confidence: 0.35 })).toEqual({
      date: null,
      reason: "low_confidence",
    });
    expect(usableDate({ date: "2026-08-25", confidence: 0.9 })).toEqual({
      date: "2026-08-25",
      reason: "ok",
    });
  });

  it("honours a caller-supplied stricter floor", () => {
    const r = { date: "2026-08-25", confidence: 0.7 };
    expect(usableDate(r).date).toBe("2026-08-25");
    expect(usableDate(r, 0.8).date).toBeNull();
  });
});

describe("no source text ever survives extraction", () => {
  it("returns only a normalized date, never a substring of the label", () => {
    const label = "Northwind Traders — renewal term end 2026-08-25 (owner: dana@example.com)";
    const r = extractDateIso(label);
    expect(r.date).toBe("2026-08-25");
    const serialized = JSON.stringify(r);
    for (const fragment of ["Northwind", "dana", "example.com", "owner", "renewal"]) {
      expect(serialized).not.toContain(fragment);
    }
  });
});

/**
 * Anti-drift contract. The SAME fixture is asserted by the Swift test runner
 * (native/macos-observer/Sources/ObserverCoreTestRunner), because the code that
 * reads a live label runs inside the observer process. This TypeScript
 * implementation is the readable specification; if either side changes
 * behaviour, one of the two suites fails.
 */
describe("date conformance fixture", () => {
  const ROOT = join(import.meta.dirname, "..", "..", "..");
  type Case = { name: string; text: string; expected: DateExtraction };
  const cases: Case[] = JSON.parse(
    readFileSync(join(ROOT, "domain", "date-conformance.json"), "utf8"),
  );

  it("covers readable, ambiguous and unreadable outcomes", () => {
    expect(cases.length).toBeGreaterThan(20);
    expect(cases.some((c) => c.expected.date === null)).toBe(true);
    expect(cases.some((c) => c.expected.confidence >= DATE_CONFIDENCE_FLOOR)).toBe(true);
    // At least one case must be a read that exists but is NOT usable — that is
    // the ambiguity behaviour the whole extractor exists to get right.
    expect(
      cases.some((c) => c.expected.date !== null && c.expected.confidence < DATE_CONFIDENCE_FLOOR),
    ).toBe(true);
  });

  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, testCase) => {
    expect(extractDateIso(testCase.text)).toEqual(testCase.expected);
  });
});
