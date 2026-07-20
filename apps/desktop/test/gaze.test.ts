import { describe, expect, it } from "vitest";
import {
  GAZE_DEAD_ZONE_PX,
  gazeFrameForAngle,
  gazeFrameForPointer,
  pointerAngleDeg,
} from "../src/pet/gaze.js";
import { NEUTRAL_FRAME } from "../src/pet/atlas.js";

describe("pointer angle (0°=up, 90°=right)", () => {
  it("maps cardinal directions correctly", () => {
    expect(pointerAngleDeg(0, -10)).toBeCloseTo(0); // up
    expect(pointerAngleDeg(10, 0)).toBeCloseTo(90); // right
    expect(pointerAngleDeg(0, 10)).toBeCloseTo(180); // down
    expect(pointerAngleDeg(-10, 0)).toBeCloseTo(270); // left
  });
});

describe("16-direction quantization (acceptance 12)", () => {
  it("returns all 16 correct frames across rows 9 and 10", () => {
    for (let i = 0; i < 16; i++) {
      const angle = i * 22.5;
      const frame = gazeFrameForAngle(angle);
      if (i < 8) {
        expect(frame).toEqual({ row: 9, column: i });
      } else {
        expect(frame).toEqual({ row: 10, column: i - 8 });
      }
    }
  });

  it("quantizes to the nearest 22.5 degrees", () => {
    expect(gazeFrameForAngle(10)).toEqual({ row: 9, column: 0 }); // closer to 0
    expect(gazeFrameForAngle(12)).toEqual({ row: 9, column: 1 }); // closer to 22.5
    expect(gazeFrameForAngle(350)).toEqual({ row: 9, column: 0 }); // wraps to 0
    expect(gazeFrameForAngle(348)).toEqual({ row: 10, column: 7 }); // 337.5
  });
});

describe("dead zone (acceptance 13)", () => {
  it("returns null (idle fallback) inside the 18px dead zone", () => {
    expect(gazeFrameForPointer(0, 0)).toBeNull();
    expect(gazeFrameForPointer(10, 10)).toBeNull(); // hypot ≈ 14.1 < 18
    expect(gazeFrameForPointer(17, 0)).toBeNull();
  });

  it("returns a frame just outside the dead zone", () => {
    expect(gazeFrameForPointer(GAZE_DEAD_ZONE_PX, 0)).toEqual({ row: 9, column: 4 }); // 90°
    expect(gazeFrameForPointer(0, GAZE_DEAD_ZONE_PX)).toEqual({ row: 10, column: 0 }); // 180°
  });
});

// Locks the Seedy look-mechanics contract (see
// src/pet/assets/seedy-source/look-mechanics.md) against the vendored atlas:
// 16 steps of 22.5° clockwise from 000°=up, cardinals in screen coordinates.
describe("Seedy look-mechanics contract", () => {
  it("places the four cardinal poses at the documented cells", () => {
    expect(gazeFrameForAngle(0)).toEqual({ row: 9, column: 0 }); // 000 up
    expect(gazeFrameForAngle(90)).toEqual({ row: 9, column: 4 }); // 090 screen-right
    expect(gazeFrameForAngle(180)).toEqual({ row: 10, column: 0 }); // 180 down
    expect(gazeFrameForAngle(270)).toEqual({ row: 10, column: 4 }); // 270 screen-left
  });

  it("row 9 carries 000°–157.5° and row 10 carries 180°–337.5°", () => {
    for (let i = 0; i < 8; i++) expect(gazeFrameForAngle(i * 22.5).row).toBe(9);
    for (let i = 8; i < 16; i++) expect(gazeFrameForAngle(i * 22.5).row).toBe(10);
  });

  it("the two documented one-step transitions cross the row boundary", () => {
    // 157.5° -> 180° is exactly one step (row 9 col 7 → row 10 col 0).
    expect(gazeFrameForAngle(157.5)).toEqual({ row: 9, column: 7 });
    expect(gazeFrameForAngle(180)).toEqual({ row: 10, column: 0 });
    // 337.5° -> 000° is exactly one step (row 10 col 7 → row 9 col 0).
    expect(gazeFrameForAngle(337.5)).toEqual({ row: 10, column: 7 });
    expect(gazeFrameForAngle(360)).toEqual({ row: 9, column: 0 });
  });

  it("the neutral/front pose is the atlas cell the source manifest names", () => {
    expect(NEUTRAL_FRAME).toEqual({ row: 0, column: 6 });
  });
});
