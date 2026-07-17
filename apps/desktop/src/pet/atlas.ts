/**
 * Maman spritesheet atlas contract (Seedy-parity animation system).
 * Single source of truth for geometry, animation rows, frame timings, and the
 * product-state → animation mapping. The generator script, the renderer, the
 * scheduler, and the tests all import from here.
 */

export const spriteVersionNumber = 2 as const;

export const ATLAS = {
  /** Full atlas pixel dimensions (WebP with transparency). */
  width: 1536,
  height: 2288,
  columns: 8,
  rows: 11,
  cellWidth: 192,
  cellHeight: 208,
  /** Logical pixel-art resolution per cell before 4x nearest-neighbor upscale. */
  logicalCellWidth: 48,
  logicalCellHeight: 52,
  scale: 4,
} as const;

export type AnimationName =
  | "idle"
  | "running-right"
  | "running-left"
  | "waving"
  | "jumping"
  | "failed"
  | "waiting"
  | "working"
  | "reviewing"
  | "look-a"
  | "look-b";

export type AnimationDef = {
  row: number;
  /** Number of frames, occupying columns 0..frames-1. */
  frames: number;
  /** Per-frame durations in ms (authoritative table). */
  durations: number[];
};

/** Authoritative animation atlas (rows and timings are locked). */
export const ANIMATIONS: Record<AnimationName, AnimationDef> = {
  idle: { row: 0, frames: 6, durations: [280, 110, 110, 140, 140, 320] },
  "running-right": { row: 1, frames: 8, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  "running-left": { row: 2, frames: 8, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  waving: { row: 3, frames: 4, durations: [140, 140, 140, 280] },
  jumping: { row: 4, frames: 5, durations: [140, 140, 140, 140, 280] },
  failed: { row: 5, frames: 8, durations: [140, 140, 140, 140, 140, 140, 140, 240] },
  waiting: { row: 6, frames: 6, durations: [150, 150, 150, 150, 150, 260] },
  working: { row: 7, frames: 6, durations: [120, 120, 120, 120, 120, 220] },
  reviewing: { row: 8, frames: 6, durations: [150, 150, 150, 150, 150, 280] },
  // Look rows carry no intrinsic timing — frames are selected by gaze direction.
  "look-a": { row: 9, frames: 8, durations: [] },
  "look-b": { row: 10, frames: 8, durations: [] },
};

/** Normal idle plays at the row-zero timing multiplied by six (quiet cadence). */
export const IDLE_SLOWDOWN = 6;
export const SLOW_IDLE_DURATIONS = ANIMATIONS.idle.durations.map((d) => d * IDLE_SLOWDOWN);

/** Transient animations play this many complete cycles, then enter slow idle. */
export const TRANSIENT_CYCLES = 3;

/** The calmest closed-eye idle frame held during `sleeping` (row 0, column 2). */
export const SLEEP_FRAME = { row: 0, column: 2 } as const;

/** Product pet-state → animation mapping (locked by the addendum). */
export const mamanAnimationMap = {
  sleeping: "idle-sleep-frame",
  idle: "idle",
  looking_around: "look-direction",
  thinking: "waiting",
  waving: "waving",
  waiting: "waiting",
  working: "working",
  reviewing: "reviewing",
  success: "jumping",
  failed: "failed",
  moving_left: "running-left",
  moving_right: "running-right",
} as const;

export type MamanAnimationState = keyof typeof mamanAnimationMap;

/** CSS background-position for an atlas cell (percentage form). */
export function framePosition(
  columnIndex: number,
  rowIndex: number,
): {
  backgroundPositionX: string;
  backgroundPositionY: string;
} {
  return {
    backgroundPositionX: `${(columnIndex / (ATLAS.columns - 1)) * 100}%`,
    backgroundPositionY: `${(rowIndex / (ATLAS.rows - 1)) * 100}%`,
  };
}

/** Every atlas cell that must contain artwork; all other cells must be transparent. */
export function requiredCells(): Array<{ row: number; column: number }> {
  const cells: Array<{ row: number; column: number }> = [];
  for (const def of Object.values(ANIMATIONS)) {
    for (let c = 0; c < def.frames; c++) cells.push({ row: def.row, column: c });
  }
  return cells;
}
