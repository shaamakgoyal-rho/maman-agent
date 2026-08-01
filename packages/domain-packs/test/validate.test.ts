import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { alternatives, lowerCeiling, validatePack, type DomainPack } from "../src/index.js";

/**
 * The pack engine must be generic: these tests assert structure and integrity
 * rules, never FinOps/RevOps specifics beyond "the shipped packs load". A third
 * domain must be addable by writing YAML only.
 */

const PACKS = join(import.meta.dirname, "..", "..", "..", "domain", "packs");
const shipped = (name: string): DomainPack => {
  const result = validatePack(JSON.parse(readFileSync(join(PACKS, `${name}.json`), "utf8")));
  if (!result.ok) throw new Error(`${name} failed: ${result.errors.join("; ")}`);
  return result.pack;
};

function minimalPack(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    domain: "testdomain",
    version: "0.1.0",
    objects: [{ id: "widget", aliases: ["thing"] }],
    actions: [{ id: "open", risk: "none" }],
    workflows: [
      { id: "wf", name: "WF", cadence: "continuous", signature: [["open", "widget", "*"]] },
    ],
    ...over,
  };
}

describe("pack schema", () => {
  it("both shipped packs load and validate", () => {
    for (const name of ["finops", "revops"]) {
      const pack = shipped(name);
      expect(pack.domain).toBe(name);
      expect(pack.workflows.length).toBeGreaterThan(0);
      expect(pack.objects.length).toBeGreaterThan(0);
    }
  });

  it("the committed JSON is in sync with the YAML source", () => {
    // packs:check enforces this in CI; assert the artifact at least parses and
    // round-trips through validation unchanged.
    for (const name of ["finops", "revops"]) {
      const raw = JSON.parse(readFileSync(join(PACKS, `${name}.json`), "utf8"));
      const result = validatePack(raw);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.pack).toEqual(raw);
    }
  });

  it("rejects unknown top-level keys rather than ignoring them", () => {
    const result = validatePack(minimalPack({ proactivty: {} }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toMatch(/unrecognized|proactivty/i);
  });

  it("rejects a malformed domain id, version, or empty taxonomy", () => {
    expect(validatePack(minimalPack({ domain: "Finops" })).ok).toBe(false);
    expect(validatePack(minimalPack({ version: "1.0" })).ok).toBe(false);
    expect(validatePack(minimalPack({ actions: [] })).ok).toBe(false);
    expect(validatePack(minimalPack({ workflows: [] })).ok).toBe(false);
  });

  it("rejects an autonomy rule with no effect and an unknown autonomy level", () => {
    const noEffect = minimalPack({
      policy: { autonomy_rules: [{ match: { action: "open" }, rule: {} }] },
    });
    expect(validatePack(noEffect).ok).toBe(false);
    const badLevel = minimalPack({
      policy: { autonomy_rules: [{ match: { action: "open" }, rule: { max_level: "yolo" } }] },
    });
    expect(validatePack(badLevel).ok).toBe(false);
  });

  it("defaults min_reps_with_template and leaves cadence explicit", () => {
    const result = validatePack(minimalPack());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.pack.workflows[0]!.min_reps_with_template).toBe(2);
  });
});

describe("referential integrity (warnings, never load failures)", () => {
  it("flags a signature action the pack never declares", () => {
    const result = validatePack(
      minimalPack({
        workflows: [
          {
            id: "wf",
            name: "WF",
            cadence: "continuous",
            signature: [["open|submit", "widget", "*"]],
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const codes = result.warnings.map((w) => w.code);
    expect(codes).toContain("unknown_signature_action");
    expect(result.warnings[0]!.message).toMatch(/can never match/);
  });

  it("flags an action used against an object it doesn't declare", () => {
    const result = validatePack(
      minimalPack({
        objects: [{ id: "widget" }, { id: "gadget" }],
        actions: [{ id: "poke", risk: "low", on: ["widget"] }],
        workflows: [
          { id: "wf", name: "WF", cadence: "continuous", signature: [["poke", "gadget", "*"]] },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warnings.map((w) => w.code)).toContain("action_object_mismatch");
  });

  it("accepts aliases and wildcards without complaint", () => {
    const result = validatePack(
      minimalPack({
        actions: [{ id: "poke", risk: "low", on: ["*"] }],
        workflows: [
          { id: "wf", name: "WF", cadence: "continuous", signature: [["poke", "thing", "*"]] },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warnings).toEqual([]);
  });

  it("flags policy and trigger references to undeclared ids", () => {
    const result = validatePack(
      minimalPack({
        policy: {
          segregation_of_duties: [{ cannot_combine: ["open", "ghost"] }],
          autonomy_rules: [{ match: { action: "phantom" }, rule: { always_gate: true } }],
        },
        proactivity: { event_triggers: [{ watch: "nowhere" }] },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const codes = result.warnings.map((w) => w.code);
    expect(codes).toContain("unknown_policy_action");
    expect(codes).toContain("unknown_trigger_object");
  });

  it("reports the known integrity gaps in the shipped packs", () => {
    // These are real defects in the authored YAML, surfaced rather than
    // silently patched (fixing them means inventing domain knowledge).
    const finops = validatePack(JSON.parse(readFileSync(join(PACKS, "finops.json"), "utf8")));
    const revops = validatePack(JSON.parse(readFileSync(join(PACKS, "revops.json"), "utf8")));
    expect(finops.ok && revops.ok).toBe(true);
    if (!finops.ok || !revops.ok) return;
    expect(finops.warnings.map((w) => w.path)).toContain("workflows.invoice_intake.signature[3]");
    expect(revops.warnings.map((w) => w.path)).toContain(
      "workflows.commission_reconciliation.signature[2]",
    );
  });
});

describe("autonomy ceilings", () => {
  it("lowerCeiling always returns the stricter level, in either order", () => {
    expect(lowerCeiling("stage_only", "draft_only")).toBe("draft_only");
    expect(lowerCeiling("draft_only", "stage_only")).toBe("draft_only");
    expect(lowerCeiling("dry_run_first", "never_autonomous")).toBe("never_autonomous");
    expect(lowerCeiling("never_autonomous", "draft_only")).toBe("never_autonomous");
    expect(lowerCeiling("stage_only", "stage_only")).toBe("stage_only");
  });
});

describe("alternation parsing", () => {
  it("splits on | and preserves the wildcard", () => {
    expect(alternatives("a|b|c")).toEqual(["a", "b", "c"]);
    expect(alternatives("*")).toEqual(["*"]);
    expect(alternatives("close_date|stage|next_step")).toEqual([
      "close_date",
      "stage",
      "next_step",
    ]);
    expect(alternatives("")).toEqual([]);
  });
});
