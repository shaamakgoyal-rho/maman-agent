import { describe, expect, it, beforeAll } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import {
  ANIMATIONS,
  ATLAS,
  framePosition,
  requiredCells,
  spriteVersionNumber,
} from "../src/pet/atlas.js";

const here = dirname(fileURLToPath(import.meta.url));
const ATLAS_PATH = join(here, "..", "src", "pet", "assets", "maman-atlas.webp");

let raw: Buffer;
let info: { width: number; height: number; channels: number };

beforeAll(async () => {
  const result = await sharp(ATLAS_PATH).raw().toBuffer({ resolveWithObject: true });
  raw = result.data;
  info = result.info as typeof info;
});

function cellAlphaSum(row: number, col: number): number {
  let sum = 0;
  const x0 = col * ATLAS.cellWidth;
  const y0 = row * ATLAS.cellHeight;
  for (let y = y0; y < y0 + ATLAS.cellHeight; y++) {
    for (let x = x0; x < x0 + ATLAS.cellWidth; x++) {
      sum += raw[(y * ATLAS.width + x) * 4 + 3]!;
    }
  }
  return sum;
}

describe("atlas geometry (acceptance 1, 2, 5)", () => {
  it("is exactly 1536 x 2288 with an alpha channel", async () => {
    const meta = await sharp(ATLAS_PATH).metadata();
    expect(meta.width).toBe(1536);
    expect(meta.height).toBe(2288);
    expect(meta.format).toBe("webp");
    expect(meta.hasAlpha).toBe(true);
    expect(info.channels).toBe(4);
  });

  it("contains an 8x11 grid of 192x208 cells", () => {
    expect(ATLAS.columns).toBe(8);
    expect(ATLAS.rows).toBe(11);
    expect(ATLAS.cellWidth).toBe(192);
    expect(ATLAS.cellHeight).toBe(208);
    expect(ATLAS.columns * ATLAS.cellWidth).toBe(1536);
    expect(ATLAS.rows * ATLAS.cellHeight).toBe(2288);
  });

  it("declares spriteVersionNumber 2", () => {
    expect(spriteVersionNumber).toBe(2);
  });
});

describe("atlas content (acceptance 3, 4)", () => {
  it("every required frame is nonempty", () => {
    for (const { row, column } of requiredCells()) {
      expect(
        cellAlphaSum(row, column),
        `row ${row} col ${column} should have artwork`,
      ).toBeGreaterThan(10_000);
    }
  });

  it("every unused cell is fully transparent", () => {
    const used = new Set(requiredCells().map((c) => `${c.row}:${c.column}`));
    for (let row = 0; row < ATLAS.rows; row++) {
      for (let col = 0; col < ATLAS.columns; col++) {
        if (used.has(`${row}:${col}`)) continue;
        expect(cellAlphaSum(row, col), `row ${row} col ${col} must be transparent`).toBe(0);
      }
    }
  });
});

describe("frame position math (acceptance 6)", () => {
  it("selects the correct atlas cell percentages", () => {
    expect(framePosition(0, 0)).toEqual({
      backgroundPositionX: "0%",
      backgroundPositionY: "0%",
    });
    expect(framePosition(7, 10)).toEqual({
      backgroundPositionX: "100%",
      backgroundPositionY: "100%",
    });
    expect(framePosition(3, 5).backgroundPositionX).toBe(`${(3 / 7) * 100}%`);
    expect(framePosition(3, 5).backgroundPositionY).toBe(`${(5 / 10) * 100}%`);
  });
});

describe("authoritative timings (acceptance 7)", () => {
  it("matches the locked table exactly", () => {
    expect(ANIMATIONS.idle.durations).toEqual([280, 110, 110, 140, 140, 320]);
    expect(ANIMATIONS["running-right"].durations).toEqual([120, 120, 120, 120, 120, 120, 120, 220]);
    expect(ANIMATIONS["running-left"].durations).toEqual([120, 120, 120, 120, 120, 120, 120, 220]);
    expect(ANIMATIONS.waving.durations).toEqual([140, 140, 140, 280]);
    expect(ANIMATIONS.jumping.durations).toEqual([140, 140, 140, 140, 280]);
    expect(ANIMATIONS.failed.durations).toEqual([140, 140, 140, 140, 140, 140, 140, 240]);
    expect(ANIMATIONS.waiting.durations).toEqual([150, 150, 150, 150, 150, 260]);
    expect(ANIMATIONS.working.durations).toEqual([120, 120, 120, 120, 120, 220]);
    expect(ANIMATIONS.reviewing.durations).toEqual([150, 150, 150, 150, 150, 280]);
  });

  it("maps rows exactly per the table", () => {
    expect(ANIMATIONS.idle.row).toBe(0);
    expect(ANIMATIONS["running-right"].row).toBe(1);
    expect(ANIMATIONS["running-left"].row).toBe(2);
    expect(ANIMATIONS.waving.row).toBe(3);
    expect(ANIMATIONS.jumping.row).toBe(4);
    expect(ANIMATIONS.failed.row).toBe(5);
    expect(ANIMATIONS.waiting.row).toBe(6);
    expect(ANIMATIONS.working.row).toBe(7);
    expect(ANIMATIONS.reviewing.row).toBe(8);
    expect(ANIMATIONS["look-a"].row).toBe(9);
    expect(ANIMATIONS["look-b"].row).toBe(10);
  });
});

describe("asset provenance (owner-authorized Seedy pet)", () => {
  // The pet uses the "Seedy" spritesheet, vendored with the owner's
  // authorization (the project owner owns Seedy). Provenance is auditable: the
  // authoritative source package is committed under assets/seedy-source, and the
  // committed atlas must be a byte-for-byte copy of that vendored source.
  const SEEDY_SOURCE = join(here, "..", "src", "pet", "assets", "seedy-source", "spritesheet.webp");

  it("vendors the authoritative Seedy source package (atlas + brief + manifest)", () => {
    const dir = join(here, "..", "src", "pet", "assets", "seedy-source");
    expect(statSync(join(dir, "spritesheet.webp")).isFile()).toBe(true);
    expect(statSync(join(dir, "pet.json")).isFile()).toBe(true);
    expect(statSync(join(dir, "character-brief.md")).isFile()).toBe(true);
  });

  it("the committed atlas is byte-for-byte the vendored Seedy source", () => {
    const source = readFileSync(SEEDY_SOURCE);
    const committed = readFileSync(ATLAS_PATH);
    expect(committed.equals(source)).toBe(true);
  });

  it("the generator that reproduces the atlas from the vendored source exists", () => {
    expect(statSync(join(here, "..", "scripts", "generate-spritesheet.ts")).isFile()).toBe(true);
  });
});
