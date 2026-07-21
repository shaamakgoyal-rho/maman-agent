# Seedy — cute pixel-art Codex pet source

Seedy is a rosy-cheeked 16-bit sprout bot packaged for the Codex v2 pet format. This folder includes the finished installable pet, every normalized source frame, the source reference and generation prompts, plus a deterministic builder and validator.

## Build

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python source/build_pet.py
```

The finished package is written to `dist/seedy/`:

```text
dist/seedy/
├── pet.json
└── spritesheet.webp
```

To build, validate, and install Seedy into Codex in one step:

```bash
python source/build_pet.py --install
```

That copies the two package files to `~/.codex/pets/seedy/`.

## Reproducibility

- `source/frames/` is the deterministic pixel source of truth. Rebuilding from it reproduces the complete transparent 8 × 11 atlas.
- `source/build_pet.py` enforces 192 × 208 cells, a 1536 × 2288 atlas, required and unused cell occupancy, clean transparent pixels, and the v2 manifest.
- `source/extract_frames.py` recovers the normalized frame tree from a completed v2 atlas.
- `source/generation/` preserves the supplied style reference, canonical character base, character brief, look mechanics, and every visual-generation prompt. Image generation is probabilistic; rerunning prompts creates a close new interpretation, while rebuilding from `source/frames/` is exact.
- `qa/` contains the final contact sheet, animated previews, direction checks, and validation evidence.

### Vendored generation artifacts (in this folder)

For an auditable in-repo record, the key generation artifacts are vendored here alongside the finished `spritesheet.webp`:

- `canonical-base.png` — the canonical front-facing base pose the whole atlas is registered against.
- `character-brief.md`, `look-mechanics.md` — the authoritative style + 16-direction look specification.
- `look-row-10-registration.json` — the row-10 (look directions 180°–337.5°) registration scale (`0.684`) applied during generation so the sprout-bend poses land at the same on-cell scale as the rest of the atlas. It is a generation-time calibration record, not a runtime value: the committed `spritesheet.webp` already has this registration baked in (row-10 content measures ≈0.93 of the neutral pose, matching row 9), so the renderer needs no per-row correction.
- `pet-request.json` — the generation request that produced this run.

The committed atlas `../maman-atlas.webp` is byte-identical to `dist/seedy/spritesheet.webp` from this source run (verified by sha256), and `generate-spritesheet.ts` reproduces it by copying `spritesheet.webp`.

## Atlas contract

| Row | State                                 |                                  Frames |
| --: | ------------------------------------- | --------------------------------------: |
|   0 | idle                                  | 6 animation frames + neutral/front slot |
|   1 | running-right                         |                                       8 |
|   2 | running-left                          |                                       8 |
|   3 | waving                                |                                       4 |
|   4 | jumping                               |                                       5 |
|   5 | failed                                |                                       8 |
|   6 | waiting                               |                                       6 |
|   7 | running (active work, not locomotion) |                                       6 |
|   8 | review                                |                                       6 |
|   9 | look directions 000° through 157.5°   |                                       8 |
|  10 | look directions 180° through 337.5°   |                                       8 |

The package uses `spriteVersionNumber: 2`. Look directions run clockwise and `000°` means up. The dedicated neutral/front cell is row 0, column 6; column 7 remains transparent.
