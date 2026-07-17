import { ANIMATIONS } from "./atlas.js";

/**
 * Seedy-style 16-direction gaze.
 * 0° = up, 90° = screen-right, 180° = down, 270° = screen-left.
 * Rows 9 (0°–157.5°) and 10 (180°–337.5°), quantized to the nearest 22.5°.
 */

export const GAZE_DEAD_ZONE_PX = 18;
export const GAZE_LINGER_MS = 1500;

/** Angle in degrees (0=up, clockwise) for a pointer offset from the pet center. */
export function pointerAngleDeg(dx: number, dy: number): number {
  // atan2(dx, -dy): up is 0°, right is 90°.
  const rad = Math.atan2(dx, -dy);
  const deg = (rad * 180) / Math.PI;
  return (deg + 360) % 360;
}

/** Quantizes an angle to a 16-direction atlas frame. */
export function gazeFrameForAngle(angleDeg: number): { row: number; column: number } {
  const index = Math.round((((angleDeg % 360) + 360) % 360) / 22.5) % 16;
  return index < 8
    ? { row: ANIMATIONS["look-a"].row, column: index }
    : { row: ANIMATIONS["look-b"].row, column: index - 8 };
}

/**
 * Gaze frame for a pointer offset, or null inside the dead zone (fall back to
 * idle). The pet never rotates or skews — only the authored look frames move.
 */
export function gazeFrameForPointer(
  dx: number,
  dy: number,
  deadZonePx: number = GAZE_DEAD_ZONE_PX,
): { row: number; column: number } | null {
  if (Math.hypot(dx, dy) < deadZonePx) return null;
  return gazeFrameForAngle(pointerAngleDeg(dx, dy));
}
