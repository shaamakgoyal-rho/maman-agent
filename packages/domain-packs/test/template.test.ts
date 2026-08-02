import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  matchEpisode,
  matchSignature,
  templateReps,
  validatePack,
  MAX_NOISE_BETWEEN_STEPS,
  type DomainPack,
  type TemplateStepInput,
} from "../src/index.js";

const PACKS = join(import.meta.dirname, "..", "..", "..", "domain", "packs");
function shipped(name: string): DomainPack {
  const r = validatePack(JSON.parse(readFileSync(join(PACKS, `${name}.json`), "utf8")));
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.pack;
}
const finops = shipped("finops");
const revops = shipped("revops");

const step = (
  domain_action?: string,
  domain_object?: string,
  target_role?: string,
): TemplateStepInput => ({
  ...(domain_action ? { domain_action } : {}),
  ...(domain_object ? { domain_object } : {}),
  ...(target_role ? { target_role } : {}),
});

/** The finops three_way_match signature, satisfied exactly. */
const THREE_WAY: TemplateStepInput[] = [
  step("open", "invoice", "row"),
  step("open", "purchase_order", "row"),
  step("three_way_match", "invoice", "table"),
  step("approve_invoice", "invoice", "button"),
];

describe("matchSignature", () => {
  const workflow = finops.workflows.find((w) => w.id === "three_way_match")!;

  it("matches an exact ordered sequence, with * accepting any role", () => {
    expect(matchSignature(finops, workflow, THREE_WAY)).toBe(true);
  });

  it("matches through alternation (flag_exception instead of approve_invoice)", () => {
    const steps = [...THREE_WAY.slice(0, 3), step("flag_exception", "invoice")];
    expect(matchSignature(finops, workflow, steps)).toBe(true);
  });

  it("enforces order — the same steps shuffled are not the workflow", () => {
    const shuffled = [THREE_WAY[2]!, THREE_WAY[0]!, THREE_WAY[1]!, THREE_WAY[3]!];
    expect(matchSignature(finops, workflow, shuffled)).toBe(false);
  });

  it("tolerates bounded noise between steps but not a scattered signature", () => {
    const noise = step(undefined, undefined, "cell");
    const bounded = [
      THREE_WAY[0]!,
      ...Array(MAX_NOISE_BETWEEN_STEPS).fill(noise),
      ...THREE_WAY.slice(1),
    ];
    expect(matchSignature(finops, workflow, bounded)).toBe(true);
    const scattered = [
      THREE_WAY[0]!,
      ...Array(MAX_NOISE_BETWEEN_STEPS + 1).fill(noise),
      ...THREE_WAY.slice(1),
    ];
    expect(matchSignature(finops, workflow, scattered)).toBe(false);
  });

  it("allows unlimited leading noise before the workflow starts", () => {
    const noise = Array(20).fill(step(undefined, undefined, "window"));
    expect(matchSignature(finops, workflow, [...noise, ...THREE_WAY])).toBe(true);
  });

  it("an unclassified event cannot satisfy a concrete cell", () => {
    const missingAction = [step(undefined, "invoice", "row"), ...THREE_WAY.slice(1)];
    expect(matchSignature(finops, workflow, missingAction)).toBe(false);
  });

  it("a partial prefix is not a match", () => {
    expect(matchSignature(finops, workflow, THREE_WAY.slice(0, 3))).toBe(false);
  });

  it("resolves object aliases to canonical ids", () => {
    const wf = revops.workflows.find((w) => w.id === "quote_to_cash")!;
    const steps = [
      step("open", "deal"), // alias of opportunity
      step("extract_field", "opp"), // alias of opportunity
      step("generate_quote", "proposal"), // alias of quote
      step("draft_email", "quote"),
    ];
    expect(matchSignature(revops, wf, steps)).toBe(true);
  });
});

describe("matchEpisode", () => {
  it("finds the workflow across packs and reports its metadata", () => {
    const match = matchEpisode([revops, finops], THREE_WAY);
    expect(match).toEqual({
      pack_domain: "finops",
      workflow_id: "three_way_match",
      workflow_name: "PO / invoice / receipt match",
      cadence: "continuous",
      min_reps_with_template: 2,
    });
  });

  it("returns null for an episode with no domain typing at all", () => {
    const untyped = [step(undefined, undefined, "row"), step(undefined, undefined, "cell")];
    expect(matchEpisode([finops, revops], untyped)).toBeNull();
  });

  it("is deterministic across pack order", () => {
    const a = matchEpisode([finops, revops], THREE_WAY);
    const b = matchEpisode([revops, finops], THREE_WAY);
    expect(a).toEqual(b);
  });
});

describe("templateReps (cadence-aware repetition counting)", () => {
  it("fiscal_monthly counts distinct months, not raw episodes", () => {
    const dates = [
      "2026-06-30T18:00:00.000Z",
      "2026-06-30T19:00:00.000Z", // same close, same month
      "2026-07-31T18:00:00.000Z",
    ];
    expect(templateReps(dates, "fiscal_monthly")).toBe(2);
    expect(templateReps(dates, "continuous")).toBe(3);
  });

  it("weekly counts distinct ISO weeks across a year boundary correctly", () => {
    // 2025-12-29 (Mon) and 2026-01-02 (Fri) are the SAME ISO week (2026-W01).
    expect(templateReps(["2025-12-29T09:00:00.000Z", "2026-01-02T09:00:00.000Z"], "weekly")).toBe(
      1,
    );
    expect(templateReps(["2026-01-02T09:00:00.000Z", "2026-01-05T09:00:00.000Z"], "weekly")).toBe(
      2,
    );
  });

  it("event_driven and date_driven count every episode", () => {
    const dates = ["2026-08-01T10:00:00.000Z", "2026-08-01T11:00:00.000Z"];
    expect(templateReps(dates, "event_driven")).toBe(2);
    expect(templateReps(dates, "date_driven")).toBe(2);
  });
});
