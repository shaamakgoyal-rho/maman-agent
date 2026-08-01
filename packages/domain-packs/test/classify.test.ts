import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyEvent,
  exceedsThreshold,
  extractAmountUsd,
  extractDiscountPct,
  validatePack,
  type DomainPack,
} from "../src/index.js";

const PACKS = join(import.meta.dirname, "..", "..", "..", "domain", "packs");
function shipped(name: string): DomainPack {
  const r = validatePack(JSON.parse(readFileSync(join(PACKS, `${name}.json`), "utf8")));
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.pack;
}
const finops = shipped("finops");
const revops = shipped("revops");
const both = [finops, revops];

describe("classifyEvent", () => {
  it("returns null rather than forcing a mapping when nothing matches", () => {
    expect(classifyEvent(both, { app_category: "other", event_type: "app_activated" })).toBeNull();
    expect(classifyEvent([], { app_category: "crm", event_type: "record_opened" })).toBeNull();
  });

  it("classifies from an already-derived object_type without needing label text", () => {
    const result = classifyEvent(both, {
      app_category: "crm",
      event_type: "record_opened",
      object_type: "opportunity",
    });
    expect(result).not.toBeNull();
    expect(result!.domain).toBe("revops");
    expect(result!.object).toBe("opportunity");
    expect(result!.confidence).toBeGreaterThan(0);
  });

  it("resolves an object through its alias", () => {
    // revops declares opportunity with aliases [deal, opp].
    const result = classifyEvent(both, { event_type: "record_opened", object_type: "deal" });
    expect(result?.object).toBe("opportunity");
  });

  it("uses matched label PATTERNS, never label text", () => {
    const result = classifyEvent([finops], {
      app_category: "erp",
      event_type: "record_opened",
      // The observer reports which pattern fired — not what it fired against.
      label_pattern_hits: ["invoice"],
    });
    expect(result?.domain).toBe("finops");
    expect(result?.object).toBe("invoice");
  });

  it("never classifies a read-only event as a mutating action", () => {
    const result = classifyEvent([finops], {
      event_type: "record_opened",
      object_type: "invoice",
    });
    expect(result).not.toBeNull();
    const action = finops.actions.find((a) => a.id === result!.action);
    // A mere "open" must not imply approve/post/schedule.
    expect(["none", "low"]).toContain(action?.risk);
  });

  it("only picks an action the pack declares for that object", () => {
    const result = classifyEvent([finops], {
      event_type: "value_committed",
      object_type: "invoice",
    });
    if (result?.action) {
      const action = finops.actions.find((a) => a.id === result.action)!;
      const applies =
        action.on.length === 0 || action.on.includes("*") || action.on.includes("invoice");
      expect(applies).toBe(true);
    }
  });

  it("is deterministic and independent of pack order", () => {
    const input = { app_category: "crm", event_type: "record_opened", object_type: "account" };
    const a = classifyEvent([finops, revops], input);
    const b = classifyEvent([revops, finops], input);
    expect(a).toEqual(b);
    expect(classifyEvent(both, input)).toEqual(a);
  });

  it("confidence rises with corroborating evidence", () => {
    const weak = classifyEvent([finops], { event_type: "record_opened", object_type: "invoice" })!;
    const strong = classifyEvent([finops], {
      event_type: "record_opened",
      object_type: "invoice",
      app_category: "erp",
      label_pattern_hits: ["invoice"],
    })!;
    expect(strong.confidence).toBeGreaterThan(weak.confidence);
    expect(strong.confidence).toBeLessThanOrEqual(1);
  });
});

describe("extractors fail CLOSED", () => {
  it("unreadable input counts as threshold exceeded, not as under", () => {
    const nothing = extractAmountUsd(undefined);
    expect(nothing.value).toBeNull();
    expect(nothing.confidence).toBe(0);
    const verdict = exceedsThreshold(nothing, 5000);
    expect(verdict.exceeded).toBe(true);
    expect(verdict.reason).toBe("unreadable");
  });

  it("a low-confidence read counts as exceeded even when the value looks small", () => {
    // Bare number, several candidates → ambiguous, low confidence.
    const ambiguous = extractAmountUsd("12 34 56");
    expect(ambiguous.value).not.toBeNull();
    expect(ambiguous.confidence).toBeLessThan(0.6);
    const verdict = exceedsThreshold(ambiguous, 5000);
    expect(verdict.exceeded).toBe(true);
    expect(verdict.reason).toBe("low_confidence");
  });

  it("a confident read under the threshold does not gate", () => {
    const clear = extractAmountUsd("USD 1,250.00");
    expect(clear.value).toBe(1250);
    expect(clear.confidence).toBeGreaterThanOrEqual(0.6);
    expect(exceedsThreshold(clear, 5000)).toEqual({ exceeded: false, reason: "under" });
  });

  it("a confident read over the threshold gates", () => {
    const big = extractAmountUsd("$7,500.50");
    expect(big.value).toBe(7500.5);
    expect(exceedsThreshold(big, 5000)).toEqual({ exceeded: true, reason: "over_threshold" });
  });

  it("a bare number is not a percentage", () => {
    expect(extractDiscountPct("15").value).toBeNull();
    expect(exceedsThreshold(extractDiscountPct("15"), 10).exceeded).toBe(true);
  });

  it("reads a real percentage and compares it", () => {
    expect(extractDiscountPct("12.5%").value).toBe(12.5);
    expect(exceedsThreshold(extractDiscountPct("12.5%"), 10).reason).toBe("over_threshold");
    expect(exceedsThreshold(extractDiscountPct("5%"), 10).exceeded).toBe(false);
  });

  it("rejects an out-of-range percentage rather than clamping it", () => {
    expect(extractDiscountPct("450%").value).toBeNull();
    expect(exceedsThreshold(extractDiscountPct("450%"), 10).reason).toBe("unreadable");
  });
});
