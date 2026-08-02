import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validatePack, type DomainPack } from "@maman/domain-packs";
import type { PatternFeatureEvent } from "@maman/contracts";
import { runPatternEngine, type EngineOptions } from "../src/engine.js";

/**
 * Template-primed detection (L2): a pack workflow performed per its cadence
 * must surface at min_reps_with_template, honestly labelled as a template
 * match — while the safety bars stay unavoidable and untyped episodes keep
 * flowing through novel clustering exactly as before.
 */

const PACKS = join(import.meta.dirname, "..", "..", "..", "domain", "packs");
function shipped(name: string): DomainPack {
  const r = validatePack(JSON.parse(readFileSync(join(PACKS, `${name}.json`), "utf8")));
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.pack;
}
const packs = [shipped("finops"), shipped("revops")];

const OWNER = "00000000-0000-7000-8000-000000000001";
let counter = 0;

type Step = {
  event_type: PatternFeatureEvent["event_type"];
  domain_action?: string;
  domain_object?: string;
  target_role?: string;
  object_type?: string;
};

/** finops three_way_match, as classified CRM/ERP events. */
const THREE_WAY_STEPS: Step[] = [
  {
    event_type: "record_opened",
    domain_action: "open",
    domain_object: "invoice",
    target_role: "row",
    object_type: "invoice",
  },
  {
    event_type: "record_opened",
    domain_action: "open",
    domain_object: "purchase_order",
    target_role: "row",
    object_type: "purchase_order",
  },
  {
    event_type: "table_read",
    domain_action: "three_way_match",
    domain_object: "invoice",
    target_role: "table",
    object_type: "invoice",
  },
  {
    event_type: "value_committed",
    domain_action: "flag_exception",
    domain_object: "invoice",
    target_role: "button",
    object_type: "invoice",
  },
];

function episodeEvents(steps: Step[], startIso: string): PatternFeatureEvent[] {
  const start = Date.parse(startIso);
  return steps.map((s, i) => {
    counter++;
    return {
      event_id: `00000000-0000-7000-8000-${String(counter).padStart(12, "0")}`,
      occurred_at: new Date(start + i * 30_000).toISOString(),
      monotonic_ms: counter * 1000,
      source: "chrome",
      app_category: "crm",
      event_type: s.event_type,
      ...(s.target_role ? { target_role: s.target_role } : {}),
      ...(s.object_type ? { object_type: s.object_type } : {}),
      duration_ms: 30_000,
      sensitivity: "internal",
      excluded_from_learning: false,
      ...(s.domain_action || s.domain_object
        ? {
            pack_domain: "finops",
            ...(s.domain_object ? { domain_object: s.domain_object } : {}),
            ...(s.domain_action ? { domain_action: s.domain_action } : {}),
            classifier_confidence: 0.8,
          }
        : {}),
    };
  });
}

function options(over: Partial<EngineOptions> = {}): EngineOptions {
  return {
    owner_user_id: OWNER,
    now: () => new Date("2026-08-03T09:00:00.000Z"),
    packs,
    ...over,
  };
}

describe("template-primed detection", () => {
  const twoReps = [
    ...episodeEvents(THREE_WAY_STEPS, "2026-08-01T10:00:00.000Z"),
    ...episodeEvents(THREE_WAY_STEPS, "2026-08-01T11:00:00.000Z"),
  ];

  it("two same-day reps of a known workflow surface as a template recommendation", () => {
    const result = runPatternEngine(twoReps, options());
    expect(result.recommendations).toHaveLength(1);
    const rec = result.recommendations[0]!;
    expect(rec.template).toMatchObject({
      pack_domain: "finops",
      workflow_id: "three_way_match",
      workflow_name: "PO / invoice / receipt match",
      reps: 2,
      min_reps: 2,
    });
    expect(rec.title).toBe("PO / invoice / receipt match");
    expect(rec.summary).toContain("known finops workflow");
    const candidate = result.candidates.find((c) => c.pattern_id === rec.pattern_id)!;
    expect(candidate.template_id).toBe("finops/three_way_match");
    expect(candidate.status).toBe("eligible");
    // The generic volume bars would have rejected this (1 day < 2, minutes low):
    const generic = runPatternEngine(twoReps, options({ packs: [] }));
    expect(generic.recommendations).toEqual([]);
  });

  it("one rep is forming (watching), named after the workflow, not surfaced", () => {
    const oneRep = episodeEvents(THREE_WAY_STEPS, "2026-08-01T10:00:00.000Z");
    const result = runPatternEngine(oneRep, options());
    expect(result.recommendations).toEqual([]);
    expect(result.watching).toHaveLength(1);
    expect(result.watching[0]!.naming.title).toBe("PO / invoice / receipt match");
    expect(result.watching[0]!.candidate.template_id).toBe("finops/three_way_match");
  });

  it("fiscal_monthly cadence counts months: two same-month closes are 1 rep", () => {
    const accrualSteps: Step[] = [
      {
        event_type: "record_opened",
        domain_action: "open",
        domain_object: "close_task",
        target_role: "row",
        object_type: "close_task",
      },
      {
        event_type: "table_read",
        domain_action: "extract_field",
        domain_object: "accrual",
        target_role: "cell",
        object_type: "accrual",
      },
      {
        event_type: "value_committed",
        domain_action: "post_journal",
        domain_object: "accrual",
        target_role: "form",
        object_type: "accrual",
      },
    ];
    const sameMonth = [
      ...episodeEvents(accrualSteps, "2026-06-29T18:00:00.000Z"),
      ...episodeEvents(accrualSteps, "2026-06-30T18:00:00.000Z"),
    ];
    const oneRep = runPatternEngine(sameMonth, options());
    expect(oneRep.recommendations).toEqual([]);
    expect(
      oneRep.watching.some((w) => w.candidate.template_id === "finops/month_end_accruals"),
    ).toBe(true);

    const twoMonths = [
      ...episodeEvents(accrualSteps, "2026-06-30T18:00:00.000Z"),
      ...episodeEvents(accrualSteps, "2026-07-31T18:00:00.000Z"),
    ];
    const twoReps = runPatternEngine(twoMonths, options());
    expect(
      twoReps.recommendations.some((r) => r.template?.workflow_id === "month_end_accruals"),
    ).toBe(true);
  });

  it("suppression and dismissal apply to template matches like any pattern", () => {
    const base = runPatternEngine(twoReps, options());
    const signature = base.candidates[0]!.canonical_sequence.join("|");
    const suppressed = runPatternEngine(twoReps, options({ suppressed_signatures: [signature] }));
    expect(suppressed.recommendations).toEqual([]);
    expect(suppressed.watching).toEqual([]); // waved off — not even forming
  });

  it("untyped episodes still flow through novel clustering unchanged", () => {
    // Same events, stripped of domain typing: the template path must ignore
    // them and the generic path must still see them.
    const untyped = twoReps.map((e) => {
      const {
        pack_domain: _pd,
        domain_object: _do,
        domain_action: _da,
        classifier_confidence: _cc,
        ...rest
      } = e;
      return rest as PatternFeatureEvent;
    });
    const result = runPatternEngine(untyped, options());
    expect(result.candidates.every((c) => c.template_id === undefined)).toBe(true);
    expect(result.candidates.length).toBeGreaterThan(0); // clustered, not dropped
  });

  it("the safety bars cannot be templated around", () => {
    // A synthetic pack whose workflow tokens have no capability mapping at all
    // (feasibility 0 < 0.6): recognized, counted, but NEVER surfaced.
    const riskyPack = validatePack({
      domain: "riskydomain",
      version: "0.1.0",
      objects: [{ id: "thing" }],
      actions: [{ id: "zap", risk: "critical", on: ["thing"] }],
      workflows: [
        {
          id: "zap_things",
          name: "Zap things",
          cadence: "continuous",
          signature: [["zap", "thing", "*"]],
          min_reps_with_template: 1,
        },
      ],
    });
    if (!riskyPack.ok) throw new Error("fixture pack must validate");
    const zapEvents: PatternFeatureEvent[] = [
      "2026-08-01T10:00:00.000Z",
      "2026-08-01T11:00:00.000Z",
    ].flatMap((start, run) =>
      [0, 1, 2].map((i) => {
        counter++;
        return {
          event_id: `00000000-0000-7000-8000-${String(counter).padStart(12, "0")}`,
          occurred_at: new Date(Date.parse(start) + i * 20_000).toISOString(),
          monotonic_ms: (run * 10 + i) * 1000 + 500_000,
          source: "macos_ax",
          app_category: "other",
          event_type: "value_committed",
          duration_ms: 20_000,
          sensitivity: "internal",
          excluded_from_learning: false,
          pack_domain: "riskydomain",
          domain_object: "thing",
          domain_action: "zap",
          classifier_confidence: 0.9,
        } satisfies PatternFeatureEvent;
      }),
    );
    const result = runPatternEngine(zapEvents, options({ packs: [riskyPack.pack] }));
    expect(result.recommendations).toEqual([]);
    const candidate = result.candidates.find((c) => c.template_id === "riskydomain/zap_things");
    expect(candidate).toBeDefined();
    expect(candidate!.status).toBe("candidate"); // recognized but not eligible
    // Visible as forming so the block is transparent, never silent.
    expect(result.watching.some((w) => w.candidate.template_id === "riskydomain/zap_things")).toBe(
      true,
    );
  });
});
