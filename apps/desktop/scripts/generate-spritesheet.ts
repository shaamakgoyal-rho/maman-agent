/**
 * Generates the ORIGINAL Maman pixel-art spritesheet atlas.
 *
 * Every frame is rendered from one parametrized pose model so character
 * identity, proportions, face geometry, palette, outline width, pixel density,
 * baseline, and accessory placement stay consistent across the whole set.
 * No external artwork is imported — this is not a trace or recolor of any
 * existing mascot's spritesheet.
 *
 * Output: src/pet/assets/maman-atlas.webp — 1536x2288, 8x11 grid of 192x208
 * cells, lossless WebP with transparency, drawn at 48x52 and upscaled 4x
 * nearest-neighbor for crisp pixels.
 *
 * Run: pnpm exec tsx scripts/generate-spritesheet.ts
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { ANIMATIONS, ATLAS } from "../src/pet/atlas.js";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", "src", "pet", "assets", "maman-atlas.webp");

// ---- palette (flat cel tones only — no gradients, shadows, or glow) ----
const P = {
  outline: [0x2b, 0x27, 0x50, 255],
  body: [0x5b, 0x54, 0xe8, 255],
  bodyShade: [0x47, 0x40, 0xc4, 255],
  lavender: [0xad, 0xa9, 0xf6, 255],
  cream: [0xff, 0xf3, 0xe2, 255],
  teal: [0x17, 0xa0, 0x8d, 255],
  tealShade: [0x0e, 0x7a, 0x6c, 255],
  blush: [0xf2, 0xa9, 0xa2, 255],
  white: [0xff, 0xff, 0xff, 255],
} as const;
type ColorName = keyof typeof P;

const W = ATLAS.logicalCellWidth; // 48
const H = ATLAS.logicalCellHeight; // 52

type Grid = (ColorName | null)[][];
const newGrid = (): Grid => Array.from({ length: H }, () => Array<ColorName | null>(W).fill(null));

function set(g: Grid, x: number, y: number, c: ColorName) {
  if (x >= 0 && x < W && y >= 0 && y < H) g[y]![x] = c;
}
function fillEllipse(g: Grid, cx: number, cy: number, rx: number, ry: number, c: ColorName) {
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) set(g, x, y, c);
    }
  }
}
function fillRect(g: Grid, x0: number, y0: number, w: number, h: number, c: ColorName) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) set(g, x, y, c);
}

/** 1px silhouette outline: filled pixels bordering emptiness become outline. */
function outlinePass(g: Grid) {
  const marks: Array<[number, number]> = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!g[y]![x]) continue;
      const nbrs = [g[y - 1]?.[x], g[y + 1]?.[x], g[y]![x - 1], g[y]![x + 1]];
      if (nbrs.some((n) => n === null || n === undefined)) marks.push([x, y]);
    }
  }
  for (const [x, y] of marks) g[y]![x] = "outline";
}

function mirror(g: Grid): Grid {
  return g.map((row) => [...row].reverse());
}

// ---- parametrized pose model ----
type Eyes = "open" | "half" | "closed" | "sad" | "focus";
type Mouth = "smile" | "flat" | "frown" | "open" | "small";
type Arm = "none" | "down" | "mid" | "up" | "out" | "chin";
type Pose = {
  dy?: number; // whole-character vertical offset (jump/bob)
  squash?: number; // 0..2 body flatten (breath/crouch)
  eyes?: Eyes;
  pupil?: [number, number]; // -2..2, -1..2
  faceShift?: [number, number]; // head-turn feel for gaze
  brows?: "none" | "raised" | "knit";
  mouth?: Mouth;
  armL?: Arm;
  armR?: Arm;
  feet?: "both" | "stepA" | "stepB" | "tuck";
  antennaLean?: number; // -2..2 x-shift of tips
  antennaDroop?: number; // 0..3 y-droop of tips (sadness posture)
};

function drawMaman(pose: Pose): Grid {
  const g = newGrid();
  const dy = pose.dy ?? 0;
  const sq = pose.squash ?? 0;
  const [pdx, pdy] = pose.pupil ?? [0, 0];
  const [fdx, fdy] = pose.faceShift ?? [0, 0];
  const lean = pose.antennaLean ?? 0;
  const droop = pose.antennaDroop ?? 0;

  // feet (baseline registered at y=44..47 unless the whole body jumps)
  const feet = pose.feet ?? "both";
  if (feet === "both") {
    fillRect(g, 17, 44 + dy, 4, 3, "bodyShade");
    fillRect(g, 27, 44 + dy, 4, 3, "bodyShade");
  } else if (feet === "stepA") {
    fillRect(g, 15, 43 + dy, 4, 3, "bodyShade"); // left forward+lifted
    fillRect(g, 28, 45 + dy, 4, 2, "bodyShade");
  } else if (feet === "stepB") {
    fillRect(g, 16, 45 + dy, 4, 2, "bodyShade");
    fillRect(g, 29, 43 + dy, 4, 3, "bodyShade"); // right forward+lifted
  } else if (feet === "tuck") {
    fillRect(g, 19, 43 + dy, 3, 2, "bodyShade");
    fillRect(g, 26, 43 + dy, 3, 2, "bodyShade");
  }

  // body blob (2-tone cel shading) — top of head at ~y=16 so the kerchief shows
  const ry = 14 - sq;
  const rx = 14 + Math.ceil(sq / 2);
  fillEllipse(g, 24, 30 + dy + sq, rx, ry, "body");
  // lower shade band
  for (let y = 37 + dy + sq; y <= 30 + dy + sq + ry; y++) {
    for (let x = 0; x < W; x++) if (g[y]?.[x] === "body") g[y]![x] = "bodyShade";
  }

  // arms
  const arm = (side: "L" | "R", kind: Arm) => {
    if (kind === "none" || kind === "down") return;
    const sx = side === "L" ? -1 : 1;
    const bx = 24 + sx * 15;
    if (kind === "mid") fillRect(g, bx + (sx === 1 ? 0 : -2), 27 + dy, 3, 4, "body");
    if (kind === "out") fillRect(g, bx + (sx === 1 ? 0 : -4), 30 + dy, 5, 3, "body");
    if (kind === "up") fillRect(g, bx + (sx === 1 ? -1 : -1), 17 + dy, 3, 6, "body");
    if (kind === "chin") fillRect(g, bx + (sx === 1 ? -4 : 1), 32 + dy, 3, 3, "body");
  };
  arm("L", pose.armL ?? "down");
  arm("R", pose.armR ?? "down");

  // teal apron with cream pocket (maternal signature accessory)
  for (let y = 34 + dy + sq; y <= 42 + dy + sq; y++) {
    for (let x = 17; x <= 31; x++) {
      const inBody = g[y]?.[x] === "body" || g[y]?.[x] === "bodyShade";
      if (inBody) g[y]![x] = y >= 40 + dy + sq ? "tealShade" : "teal";
    }
  }
  fillRect(g, 22, 37 + dy + sq, 4, 3, "cream"); // pocket

  // head kerchief (teal cap over the top of the head — maternal signature)
  for (let y = 12 + dy; y <= 20 + dy + sq; y++) {
    for (let x = 0; x < W; x++) {
      if (g[y]?.[x] === "body") g[y]![x] = "teal";
    }
  }
  // kerchief knot attached at the right edge of the cap
  fillRect(g, 32, 18 + dy + sq, 3, 2, "teal");
  fillRect(g, 34, 20 + dy + sq, 2, 2, "tealShade");

  // antennae poking through the kerchief (lavender tips), stems reach the cap
  const stemTop = 10 + dy + droop + sq;
  fillRect(g, 18 + lean, stemTop, 2, 18 + dy + sq - stemTop, "bodyShade");
  fillRect(g, 28 + lean, stemTop, 2, 18 + dy + sq - stemTop, "bodyShade");
  fillRect(g, 17 + lean + (droop > 1 ? 1 : 0), stemTop - 3, 3, 3, "lavender");
  fillRect(g, 27 + lean + (droop > 1 ? 1 : 0), stemTop - 3, 3, 3, "lavender");

  // cream face patch
  fillEllipse(g, 24 + fdx, 28 + dy + fdy, 9, 7, "cream");

  // blush
  fillRect(g, 15 + fdx, 30 + dy + fdy, 2, 1, "blush");
  fillRect(g, 31 + fdx, 30 + dy + fdy, 2, 1, "blush");

  // eyes
  const exL = 19 + fdx + pdx;
  const exR = 27 + fdx + pdx;
  const ey = 25 + dy + fdy + pdy;
  const eyes = pose.eyes ?? "open";
  if (eyes === "open") {
    fillRect(g, exL, ey, 2, 3, "outline");
    fillRect(g, exR, ey, 2, 3, "outline");
    set(g, exL, ey, "white");
    set(g, exR, ey, "white");
  } else if (eyes === "half") {
    fillRect(g, exL, ey + 1, 2, 2, "outline");
    fillRect(g, exR, ey + 1, 2, 2, "outline");
  } else if (eyes === "closed") {
    fillRect(g, exL, ey + 2, 2, 1, "outline");
    fillRect(g, exR, ey + 2, 2, 1, "outline");
  } else if (eyes === "sad") {
    set(g, exL, ey + 2, "outline");
    set(g, exL + 1, ey + 1, "outline");
    set(g, exR, ey + 1, "outline");
    set(g, exR + 1, ey + 2, "outline");
  } else if (eyes === "focus") {
    fillRect(g, exL, ey + 1, 2, 2, "outline");
    fillRect(g, exR, ey + 1, 2, 2, "outline");
    set(g, exL, ey + 1, "white");
    set(g, exR, ey + 1, "white");
  }

  // brows
  if (pose.brows === "raised") {
    fillRect(g, exL, ey - 2, 2, 1, "outline");
    fillRect(g, exR, ey - 2, 2, 1, "outline");
  } else if (pose.brows === "knit") {
    set(g, exL + 1, ey - 2, "outline");
    set(g, exL, ey - 1, "outline");
    set(g, exR, ey - 2, "outline");
    set(g, exR + 1, ey - 1, "outline");
  }

  // mouth
  const mx = 23 + fdx;
  const my = 31 + dy + fdy;
  const mouth = pose.mouth ?? "smile";
  if (mouth === "smile") {
    set(g, mx, my, "outline");
    set(g, mx + 1, my + 1, "outline");
    set(g, mx + 2, my, "outline");
  } else if (mouth === "small") {
    fillRect(g, mx + 1, my, 1, 1, "outline");
  } else if (mouth === "flat") {
    fillRect(g, mx, my, 3, 1, "outline");
  } else if (mouth === "frown") {
    set(g, mx, my + 1, "outline");
    set(g, mx + 1, my, "outline");
    set(g, mx + 2, my + 1, "outline");
  } else if (mouth === "open") {
    fillRect(g, mx, my, 3, 2, "outline");
    set(g, mx + 1, my + 1, "blush");
  }

  outlinePass(g);
  return g;
}

// ---- frame definitions per animation row ----

const idleFrames: Pose[] = [
  { eyes: "open", mouth: "smile" },
  { eyes: "half", mouth: "smile" },
  { eyes: "closed", mouth: "smile" },
  { eyes: "half", mouth: "smile" },
  { eyes: "open", mouth: "smile", squash: 1 },
  { eyes: "open", mouth: "smile" },
];

const runRight = (i: number): Pose => ({
  dy: [0, -1, -2, -1, 0, -1, -2, -1][i]!,
  feet: i % 2 === 0 ? "stepA" : "stepB",
  pupil: [2, 0],
  faceShift: [1, 0],
  antennaLean: -1,
  armL: i % 4 < 2 ? "mid" : "out",
  armR: i % 4 < 2 ? "out" : "mid",
  eyes: "open",
  mouth: "small",
});
const runningRightFrames: Pose[] = Array.from({ length: 8 }, (_, i) => runRight(i));

const wavingFrames: Pose[] = [
  { armR: "mid", eyes: "open", mouth: "smile", antennaLean: -1 },
  { armR: "up", eyes: "open", mouth: "smile" },
  { armR: "out", eyes: "open", mouth: "open", antennaLean: 1, dy: -1 },
  { armR: "up", eyes: "open", mouth: "smile" },
];

const jumpingFrames: Pose[] = [
  { squash: 2, dy: 2, eyes: "open", mouth: "small" }, // anticipation
  { dy: -4, feet: "tuck", armL: "up", armR: "up", eyes: "open", mouth: "smile" }, // lift
  { dy: -7, feet: "tuck", armL: "up", armR: "up", eyes: "open", mouth: "open" }, // peak
  { dy: -3, feet: "tuck", armL: "mid", armR: "mid", eyes: "open", mouth: "smile" }, // descend
  { squash: 1, eyes: "open", mouth: "smile" }, // settle
];

const failedFrames: Pose[] = [
  { eyes: "open", mouth: "flat" },
  { eyes: "half", mouth: "flat", antennaDroop: 1 },
  { eyes: "half", mouth: "flat", antennaDroop: 2 },
  { eyes: "sad", mouth: "frown", antennaDroop: 2, squash: 1, dy: 1 },
  { eyes: "sad", mouth: "frown", antennaDroop: 3, squash: 1, dy: 1 },
  { eyes: "closed", mouth: "frown", antennaDroop: 3, squash: 1, dy: 2 },
  { eyes: "sad", mouth: "frown", antennaDroop: 3, dy: 1 },
  { eyes: "half", mouth: "flat", antennaDroop: 2, dy: 1 },
];

const waitingFrames: Pose[] = [
  { eyes: "open", brows: "raised", mouth: "flat" },
  { eyes: "open", brows: "raised", mouth: "flat", pupil: [2, 0] },
  { eyes: "open", brows: "raised", mouth: "flat", pupil: [2, 0], armR: "mid" },
  { eyes: "open", brows: "raised", mouth: "flat" },
  { eyes: "open", brows: "raised", mouth: "flat", pupil: [-2, 0] },
  { eyes: "open", brows: "raised", mouth: "small" },
];

const workingFrames: Pose[] = [
  { eyes: "focus", mouth: "flat", armL: "mid", pupil: [0, 1] },
  { eyes: "focus", mouth: "flat", armR: "mid", pupil: [0, 1] },
  { eyes: "focus", mouth: "flat", armL: "out", pupil: [0, 1] },
  { eyes: "focus", mouth: "flat", armR: "out", pupil: [0, 1] },
  { eyes: "focus", mouth: "flat", armL: "mid", armR: "mid", pupil: [0, 1] },
  { eyes: "open", mouth: "small" },
];

const reviewingFrames: Pose[] = [
  { eyes: "open", mouth: "small", pupil: [-2, 0], armR: "chin" },
  { eyes: "open", mouth: "small", pupil: [-1, 0], armR: "chin" },
  { eyes: "open", mouth: "small", pupil: [0, 0], armR: "chin" },
  { eyes: "open", mouth: "small", pupil: [1, 0], armR: "chin" },
  { eyes: "open", mouth: "small", pupil: [2, 0], armR: "chin" },
  { eyes: "open", mouth: "smile", faceShift: [-1, 0] },
];

/** 16 look directions: 0°=up, 90°=screen-right, one continuous clockwise family. */
function lookPose(angleDeg: number): Pose {
  const a = (angleDeg * Math.PI) / 180;
  const pdx = Math.round(Math.sin(a) * 2.2);
  const pdy = Math.round(-Math.cos(a) * 1.6);
  return {
    eyes: "open",
    mouth: "small",
    pupil: [Math.max(-2, Math.min(2, pdx)), Math.max(-1, Math.min(2, pdy))],
    faceShift: [Math.round(Math.sin(a) * 1.2), Math.round(-Math.cos(a) * 0.8)],
    antennaLean: Math.round(Math.sin(a)),
  };
}
const lookAFrames: Pose[] = Array.from({ length: 8 }, (_, i) => lookPose(i * 22.5));
const lookBFrames: Pose[] = Array.from({ length: 8 }, (_, i) => lookPose(180 + i * 22.5));

// ---- compose the atlas ----

const atlas = Buffer.alloc(ATLAS.width * ATLAS.height * 4); // transparent by default

function blit(grid: Grid, row: number, col: number) {
  const ox = col * ATLAS.cellWidth;
  const oy = row * ATLAS.cellHeight;
  const s = ATLAS.scale;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = grid[y]![x];
      if (!c) continue;
      const [r, gg, b, a] = P[c];
      for (let sy = 0; sy < s; sy++) {
        for (let sx = 0; sx < s; sx++) {
          const px = ox + x * s + sx;
          const py = oy + y * s + sy;
          const i = (py * ATLAS.width + px) * 4;
          atlas[i] = r;
          atlas[i + 1] = gg;
          atlas[i + 2] = b;
          atlas[i + 3] = a;
        }
      }
    }
  }
}

const rows: Array<[number, Pose[] | Grid[]]> = [
  [ANIMATIONS.idle.row, idleFrames],
  [ANIMATIONS["running-right"].row, runningRightFrames],
  [ANIMATIONS["running-left"].row, runningRightFrames.map((p) => mirror(drawMaman(p)))],
  [ANIMATIONS.waving.row, wavingFrames],
  [ANIMATIONS.jumping.row, jumpingFrames],
  [ANIMATIONS.failed.row, failedFrames],
  [ANIMATIONS.waiting.row, waitingFrames],
  [ANIMATIONS.working.row, workingFrames],
  [ANIMATIONS.reviewing.row, reviewingFrames],
  [ANIMATIONS["look-a"].row, lookAFrames],
  [ANIMATIONS["look-b"].row, lookBFrames],
];

for (const [row, frames] of rows) {
  frames.forEach((frame, col) => {
    // A Grid is an array of rows; a Pose is a plain object.
    const grid = Array.isArray(frame) ? (frame as Grid) : drawMaman(frame as Pose);
    blit(grid, row, col);
  });
}

mkdirSync(dirname(OUT), { recursive: true });
await sharp(atlas, {
  raw: { width: ATLAS.width, height: ATLAS.height, channels: 4 },
})
  .webp({ lossless: true })
  .toFile(OUT);

console.log(`wrote ${OUT} (${ATLAS.width}x${ATLAS.height}, 8x11 grid)`);
