import { describe, expect, it } from "vitest";
import { mamanAnimationMap, type MamanAnimationState } from "../src/pet/atlas.js";
import { planForState } from "../src/pet/scheduler.js";

describe("all pet states are reachable in demo mode (acceptance 20)", () => {
  const states = Object.keys(mamanAnimationMap) as MamanAnimationState[];

  it("covers all twelve mapped states", () => {
    expect(states.sort()).toEqual(
      [
        "sleeping",
        "idle",
        "looking_around",
        "thinking",
        "waving",
        "waiting",
        "working",
        "reviewing",
        "success",
        "failed",
        "moving_left",
        "moving_right",
      ].sort(),
    );
  });

  it("every state produces a valid playback plan in both motion modes", () => {
    for (const state of states) {
      for (const reduced of [false, true]) {
        const plan = planForState(state, reduced);
        expect(plan.kind).toMatch(/static|loop|transient/);
        if (plan.kind !== "static") {
          expect(plan.frames.length).toBeGreaterThan(0);
          for (const f of plan.frames) {
            expect(f.row).toBeGreaterThanOrEqual(0);
            expect(f.row).toBeLessThan(11);
            expect(f.column).toBeGreaterThanOrEqual(0);
            expect(f.column).toBeLessThan(8);
            expect(f.duration).toBeGreaterThan(0);
          }
        }
      }
    }
  });
});
