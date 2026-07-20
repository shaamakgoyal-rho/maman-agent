/**
 * Produces the committed Maman pet atlas from the vendored Seedy source.
 *
 * Provenance: the pet uses the "Seedy" pixel-art spritesheet, vendored into this
 * repository with the owner's authorization (the project owner owns Seedy). The
 * authoritative source package lives at `src/pet/assets/seedy-source/`
 * (spritesheet.webp + pet.json + character-brief.md + README.md + contact
 * sheet). This script copies that atlas to the path the renderer loads, so the
 * committed artwork is reproducible from an in-repo source and provenance is
 * auditable.
 *
 * The atlas is Seedy's v2 format — 1536x2288, 8x11 grid of 192x208 cells,
 * transparent WebP — which is exactly the contract in `src/pet/atlas.ts`
 * (idle row 0, running rows 1-2, waving 3, jumping 4, failed 5, waiting 6,
 * working 7, review 8, look rows 9-10), so it is a drop-in for the scheduler,
 * renderer, and gaze system.
 *
 * Run: pnpm exec tsx scripts/generate-spritesheet.ts
 */
import { copyFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { ATLAS } from "../src/pet/atlas.js";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(here, "..", "src", "pet", "assets", "seedy-source", "spritesheet.webp");
const OUT = join(here, "..", "src", "pet", "assets", "maman-atlas.webp");

async function main(): Promise<void> {
  if (!statSync(SOURCE).isFile()) {
    throw new Error(`vendored Seedy atlas not found at ${SOURCE}`);
  }
  const meta = await sharp(SOURCE).metadata();
  if (meta.width !== ATLAS.width || meta.height !== ATLAS.height) {
    throw new Error(
      `source atlas is ${meta.width}x${meta.height}, expected ${ATLAS.width}x${ATLAS.height}`,
    );
  }
  if (!meta.hasAlpha) throw new Error("source atlas must have an alpha channel (transparent)");
  copyFileSync(SOURCE, OUT);
  console.log(`atlas: copied vendored Seedy spritesheet -> ${OUT} (${meta.width}x${meta.height})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
