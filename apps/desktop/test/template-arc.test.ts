import { describe, expect, it } from "vitest";
import { finopsThreeWayRepFixture } from "@maman/demo-fixtures";
import { SHIPPED_PACKS } from "@maman/domain-packs";
import { runPatternEngine, toPatternFeature } from "@maman/pattern-engine";

/**
 * The TEMPLATE demo arc: two simulated reps of the finops three_way_match
 * pack workflow (classification computed by the REAL classifier inside the
 * fixture) must flow through projection → segmentation → template matching and
 * surface as an honestly-labelled template recommendation — the beat behind
 * Home's "Simulate FinOps rep" button.
 */

const OWNER = "00000000-0000-7000-8000-000000000001";
const BASE = Date.parse("2026-08-03T10:00:00.000Z");

function repEvents(count: number) {
  return Array.from({ length: count }, (_, i) =>
    finopsThreeWayRepFixture({ rep_index: i, base_at_ms: BASE }),
  )
    .flat()
    .map((e) => toPatternFeature(e));
}

const options = {
  owner_user_id: OWNER,
  now: () => new Date("2026-08-03T11:00:00.000Z"),
  packs: SHIPPED_PACKS,
};

describe("template arc: simulated FinOps reps → template card", () => {
  it("the fixture's classification comes from the real classifier, not hand-typing", () => {
    const features = repEvents(1);
    const classified = features.filter((f) => f.pack_domain === "finops");
    expect(classified.length).toBeGreaterThan(0);
    // Every classified step names a real finops object.
    const finops = SHIPPED_PACKS.find((p) => p.domain === "finops")!;
    const objectIds = new Set(finops.objects.map((o) => o.id));
    for (const f of classified) {
      if (f.domain_object) expect(objectIds.has(f.domain_object)).toBe(true);
    }
  });

  it("one rep forms (watching, workflow-named); two reps surface the template card", () => {
    const one = runPatternEngine(repEvents(1), options);
    expect(one.recommendations).toEqual([]);
    expect(one.watching.some((w) => w.candidate.template_id === "finops/three_way_match")).toBe(
      true,
    );

    const two = runPatternEngine(repEvents(2), options);
    const rec = two.recommendations.find((r) => r.template?.workflow_id === "three_way_match");
    expect(rec).toBeDefined();
    expect(rec!.title).toBe("PO / invoice / receipt match");
    expect(rec!.template).toMatchObject({ pack_domain: "finops", reps: 2, min_reps: 2 });
    // Both same-day: the generic volume bars would have refused this.
    const generic = runPatternEngine(repEvents(2), { ...options, packs: [] });
    expect(generic.recommendations).toEqual([]);
  });

  it("the seeded reconciliation arc is untouched by template matching", async () => {
    const { demoHistoryFixture } = await import("@maman/demo-fixtures");
    const features = demoHistoryFixture().map((e) => toPatternFeature(e));
    const withPacks = runPatternEngine(features, {
      owner_user_id: OWNER,
      now: () => new Date("2026-08-04T09:00:00.000Z"),
      packs: SHIPPED_PACKS,
    });
    // The fixture events carry no domain typing, so the M19 arc must be
    // byte-identical to the packless run: same candidates, same numbers.
    const withoutPacks = runPatternEngine(features, {
      owner_user_id: OWNER,
      now: () => new Date("2026-08-04T09:00:00.000Z"),
    });
    expect(withPacks.candidates).toEqual(withoutPacks.candidates);
    expect(withPacks.recommendations).toEqual(withoutPacks.recommendations);
  });
});
