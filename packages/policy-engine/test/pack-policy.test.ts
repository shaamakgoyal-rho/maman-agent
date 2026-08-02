import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractAmountUsd,
  extractDiscountPct,
  validatePack,
  type AutonomyLevel,
  type DomainPack,
} from "@maman/domain-packs";
import {
  applyPackPolicy,
  evaluatePackPolicy,
  needsHumanApproval,
  type PackPolicyStep,
} from "../src/pack-policy.js";

/**
 * Pack policy may only RESTRICT. These tests are written to fail loudly if a
 * future change ever lets policy grant autonomy, clear an approval, or let an
 * unreadable value slip under a threshold.
 */

const PACKS = join(import.meta.dirname, "..", "..", "..", "domain", "packs");
function shipped(name: string): DomainPack {
  const r = validatePack(JSON.parse(readFileSync(join(PACKS, `${name}.json`), "utf8")));
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.pack;
}
const finops = shipped("finops");
const revops = shipped("revops");

const step = (over: Partial<PackPolicyStep> = {}): PackPolicyStep => ({
  step_id: "s1",
  ...over,
});

describe("segregation of duties", () => {
  it("makes the second conflicting action a mandatory human step, with the reason", () => {
    // finops: cannot_combine [code_invoice, approve_invoice]
    const verdict = evaluatePackPolicy(
      [finops],
      step({ domain_action: "approve_invoice", object_instance: "INV-1" }),
      { sibling_actions: ["code_invoice"] },
    );
    expect(verdict.requires_human).toBe(true);
    expect(verdict.always_gate).toBe(true);
    expect(needsHumanApproval(verdict)).toBe(true);
    const sod = verdict.reasons.find((r) => r.code === "sod_conflict")!;
    expect(sod.message).toMatch(/a person approves what Maman code invoiced/i);
    expect(sod.rule_id).toMatch(/^PACK-SOD-/);
    expect(sod.pack_domain).toBe("finops");
  });

  it("spans RUNS, not just the run in front of us", () => {
    const verdict = evaluatePackPolicy(
      [finops],
      step({ domain_action: "approve_invoice", object_instance: "INV-1" }),
      { prior_actions: ["code_invoice"] }, // done in an earlier run
    );
    expect(verdict.requires_human).toBe(true);
  });

  it("does not fire when the agent did not perform the conflicting action", () => {
    const verdict = evaluatePackPolicy([finops], step({ domain_action: "approve_invoice" }), {
      sibling_actions: ["open", "extract_field"],
    });
    expect(verdict.requires_human).toBe(false);
  });

  it("applies to revops too — no domain knowledge lives in code", () => {
    // revops: cannot_combine [apply_discount, send_for_signature]
    const verdict = evaluatePackPolicy([revops], step({ domain_action: "send_for_signature" }), {
      sibling_actions: ["apply_discount"],
    });
    expect(verdict.requires_human).toBe(true);
    expect(verdict.reasons[0]!.pack_domain).toBe("revops");
  });
});

describe("autonomy rules", () => {
  it("caps to the pack level and says why, proudly", () => {
    // revops: send_email → max_level draft_only
    const verdict = evaluatePackPolicy([revops], step({ domain_action: "send_email" }));
    expect(verdict.ceiling).toBe("draft_only");
    const capped = verdict.reasons.find((r) => r.code === "autonomy_capped")!;
    expect(capped.message).toBe("Draft-only: revops policy for send email.");
  });

  it("takes the STRICTEST ceiling across matching rules and packs", () => {
    // finops send_email is draft_only; a synthetic pack adds never_autonomous.
    const stricter = validatePack({
      domain: "otherdomain",
      version: "0.1.0",
      objects: [{ id: "thing" }],
      actions: [{ id: "send_email", risk: "high" }],
      workflows: [
        { id: "w", name: "W", cadence: "continuous", signature: [["send_email", "thing", "*"]] },
      ],
      policy: {
        autonomy_rules: [
          { match: { action: "send_email" }, rule: { max_level: "never_autonomous" } },
        ],
      },
    });
    if (!stricter.ok) throw new Error("fixture must validate");
    const verdict = evaluatePackPolicy(
      [finops, stricter.pack],
      step({ domain_action: "send_email" }),
    );
    expect(verdict.ceiling).toBe("never_autonomous");
  });

  it("dual_control also forces a gate and explains team mode", () => {
    // finops: schedule_payment → draft_only + dual_control
    const verdict = evaluatePackPolicy([finops], step({ domain_action: "schedule_payment" }));
    expect(verdict.dual_control).toBe(true);
    expect(verdict.always_gate).toBe(true);
    expect(verdict.reasons.some((r) => r.code === "dual_control")).toBe(true);
  });

  it("an unmatched action is unrestricted, and an unclassified step is too", () => {
    expect(evaluatePackPolicy([finops], step({ domain_action: "open" })).reasons).toEqual([]);
    const unclassified = evaluatePackPolicy([finops], step());
    expect(unclassified).toMatchObject({
      always_gate: false,
      dual_control: false,
      requires_human: false,
      reasons: [],
    });
    expect(unclassified.ceiling).toBeUndefined();
  });
});

describe("value matchers FAIL CLOSED", () => {
  it("gates when the amount is over the threshold", () => {
    // finops: approve_invoice + amount_usd_gt 5000 → always_gate
    const verdict = evaluatePackPolicy(
      [finops],
      step({ domain_action: "approve_invoice", amount_usd: extractAmountUsd("$7,500.00") }),
    );
    expect(verdict.always_gate).toBe(true);
  });

  it("does NOT gate a confident amount under the threshold", () => {
    const verdict = evaluatePackPolicy(
      [finops],
      step({ domain_action: "approve_invoice", amount_usd: extractAmountUsd("USD 120.00") }),
    );
    expect(verdict.always_gate).toBe(false);
  });

  it("gates when the amount is UNREADABLE, and says that is why", () => {
    const verdict = evaluatePackPolicy(
      [finops],
      step({ domain_action: "approve_invoice", amount_usd: extractAmountUsd(undefined) }),
    );
    expect(verdict.always_gate).toBe(true);
    const why = verdict.reasons.find((r) => r.code === "value_unreadable")!;
    expect(why.message).toMatch(/could not read the amount/i);
  });

  it("gates when the amount was read with LOW confidence", () => {
    const ambiguous = extractAmountUsd("12 34 56");
    expect(ambiguous.value).not.toBeNull(); // a value exists...
    const verdict = evaluatePackPolicy(
      [finops],
      step({ domain_action: "approve_invoice", amount_usd: ambiguous }),
    );
    expect(verdict.always_gate).toBe(true); // ...but it is not trusted
  });

  it("percent matchers behave the same way", () => {
    // revops: apply_discount + discount_pct_gt 10 → always_gate
    const over = evaluatePackPolicy(
      [revops],
      step({ domain_action: "apply_discount", discount_pct: extractDiscountPct("15%") }),
    );
    expect(over.always_gate).toBe(true);
    const under = evaluatePackPolicy(
      [revops],
      step({ domain_action: "apply_discount", discount_pct: extractDiscountPct("5%") }),
    );
    expect(under.always_gate).toBe(false);
    const unreadable = evaluatePackPolicy(
      [revops],
      step({ domain_action: "apply_discount", discount_pct: extractDiscountPct("cheap") }),
    );
    expect(unreadable.always_gate).toBe(true);
  });

  it("an UNKNOWN record count counts as large", () => {
    // revops: bulk_update + record_count_gt 10 → dry_run_first + always_gate
    const unknown = evaluatePackPolicy([revops], step({ domain_action: "bulk_update" }));
    expect(unknown.always_gate).toBe(true);
    expect(unknown.ceiling).toBe("dry_run_first");
    const small = evaluatePackPolicy(
      [revops],
      step({ domain_action: "bulk_update", record_count: 3 }),
    );
    expect(small.always_gate).toBe(false);
  });
});

describe("applyPackPolicy can only restrict", () => {
  const levels: AutonomyLevel[] = ["dry_run_first", "stage_only", "draft_only", "never_autonomous"];

  it("never returns a more permissive level than it was given", () => {
    for (const current of levels) {
      for (const capped of levels) {
        const verdict = evaluatePackPolicy([], step());
        const result = applyPackPolicy(current, { ...verdict, ceiling: capped });
        // The result must be at least as strict as BOTH inputs.
        expect(levels.indexOf(result!)).toBeGreaterThanOrEqual(levels.indexOf(current));
        expect(levels.indexOf(result!)).toBeGreaterThanOrEqual(levels.indexOf(capped));
      }
    }
  });

  it("leaves the current ceiling alone when policy imposes none", () => {
    const unrestricted = evaluatePackPolicy([finops], step({ domain_action: "open" }));
    expect(applyPackPolicy("stage_only", unrestricted)).toBe("stage_only");
    expect(applyPackPolicy(undefined, unrestricted)).toBeUndefined();
  });

  it("imposes a ceiling where there was none", () => {
    const verdict = evaluatePackPolicy([revops], step({ domain_action: "send_email" }));
    expect(applyPackPolicy(undefined, verdict)).toBe("draft_only");
  });
});

describe("determinism", () => {
  it("is independent of pack order and repeatable", () => {
    const s = step({ domain_action: "send_email" });
    const a = evaluatePackPolicy([finops, revops], s);
    const b = evaluatePackPolicy([revops, finops], s);
    expect(a).toEqual(b);
    expect(evaluatePackPolicy([finops, revops], s)).toEqual(a);
  });
});
