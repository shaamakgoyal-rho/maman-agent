/**
 * Generates the Maman app icon from the actual Seedy pixel art.
 *
 * Source of truth: the vendored Seedy atlas neutral/front frame
 * (`src/pet/assets/seedy-source/spritesheet.webp`, row 0 col 6 — the dedicated
 * front-facing pose). That crisp pixel-art sprite is trimmed to its content and
 * nearest-neighbor upscaled (NO smoothing — Seedy's identity is hard pixel
 * edges) onto a soft leaf-green squircle, matching Seedy's cream/brown/green
 * palette. The 1024x1024 result is written to `src-tauri/icons/source.png` and
 * fed to `tauri icon` to produce every platform size.
 *
 * Run: pnpm exec tsx scripts/generate-icon.mjs   (then `tauri icon`)
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { ATLAS, NEUTRAL_FRAME } from "../src/pet/atlas.js";

const here = dirname(fileURLToPath(import.meta.url));
const SPRITE = join(here, "..", "src", "pet", "assets", "seedy-source", "spritesheet.webp");
const OUT = join(here, "..", "src-tauri", "icons", "source.png");

const CANVAS = 1024;
// macOS-style squircle: a rounded rect with a small transparent margin.
const MARGIN = 46;
const RADIUS = 224;
// Seedy fills this fraction of the canvas height (leaves-to-feet).
const SPRITE_TARGET_H = 660;

/** Leaf-green squircle background (Seedy's leaf palette), 1024x1024 PNG buffer. */
async function background() {
  const svg = `
    <svg width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#AEDC8E"/>
          <stop offset="1" stop-color="#6DA84F"/>
        </linearGradient>
        <radialGradient id="hl" cx="0.32" cy="0.26" r="0.75">
          <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.28"/>
          <stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect x="${MARGIN}" y="${MARGIN}" width="${CANVAS - 2 * MARGIN}" height="${CANVAS - 2 * MARGIN}" rx="${RADIUS}" ry="${RADIUS}" fill="url(#g)"/>
      <rect x="${MARGIN}" y="${MARGIN}" width="${CANVAS - 2 * MARGIN}" height="${CANVAS - 2 * MARGIN}" rx="${RADIUS}" ry="${RADIUS}" fill="url(#hl)"/>
    </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** The trimmed neutral Seedy sprite, nearest-neighbor upscaled to the target height. */
async function seedySprite() {
  const cw = ATLAS.cellWidth;
  const ch = ATLAS.cellHeight;
  const cell = await sharp(SPRITE)
    .extract({
      left: NEUTRAL_FRAME.column * cw,
      top: NEUTRAL_FRAME.row * ch,
      width: cw,
      height: ch,
    })
    .trim()
    .toBuffer({ resolveWithObject: true });

  const { width, height } = cell.info;
  const scale = SPRITE_TARGET_H / height;
  const targetW = Math.round(width * scale);
  const targetH = Math.round(height * scale);
  const upscaled = await sharp(cell.data)
    .resize(targetW, targetH, { kernel: sharp.kernel.nearest }) // crisp pixels, no smoothing
    .png()
    .toBuffer();
  return { buffer: upscaled, width: targetW, height: targetH };
}

async function main() {
  const bg = await background();
  const sprite = await seedySprite();
  // Center horizontally; sit the sprite slightly above the vertical center so
  // the sprout leaves have headroom and the feet rest near the lower third.
  const left = Math.round((CANVAS - sprite.width) / 2);
  const top = Math.round((CANVAS - sprite.height) / 2) - 8;
  mkdirSync(dirname(OUT), { recursive: true });
  await sharp(bg)
    .composite([{ input: sprite.buffer, left, top }])
    .png()
    .toFile(OUT);
  console.log(`wrote ${OUT} (${CANVAS}x${CANVAS}, Seedy ${sprite.width}x${sprite.height})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
