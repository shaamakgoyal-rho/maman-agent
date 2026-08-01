/**
 * Compiles domain/packs/*.yaml → domain/packs/*.json (committed).
 *
 * Why a compile step: the packs are authored in YAML for humans, but BOTH
 * consumers need them at runtime — the Rust core (classification at ingest,
 * pushing label patterns to the observer) and the webview (template matching).
 * Compiling to JSON means one parser instead of two, no YAML crate in Rust, and
 * nothing new inside the observer, which by CI guard may have no dependencies
 * at all. Same generated-artifact pattern as the sprite atlas.
 *
 * Run: pnpm packs:generate   Check for drift: pnpm packs:check
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { parse } from "yaml";
import { validatePack } from "../src/index.js";

const PACKS_DIR = join(import.meta.dirname, "..", "..", "..", "domain", "packs");
const checkOnly = process.argv.includes("--check");

let failed = false;
let warningCount = 0;

for (const file of readdirSync(PACKS_DIR)
  .filter((f) => f.endsWith(".yaml"))
  .sort()) {
  const name = basename(file, ".yaml");
  const result = validatePack(parse(readFileSync(join(PACKS_DIR, file), "utf8")));

  if (!result.ok) {
    failed = true;
    console.error(`✗ ${file} failed validation:`);
    for (const e of result.errors) console.error(`    ${e}`);
    continue;
  }

  for (const w of result.warnings) {
    warningCount++;
    console.warn(`  ! ${file} ${w.path}: ${w.message}`);
  }

  const json = `${JSON.stringify(result.pack, null, 2)}\n`;
  const out = join(PACKS_DIR, `${name}.json`);
  if (checkOnly) {
    let current = "";
    try {
      current = readFileSync(out, "utf8");
    } catch {
      current = "";
    }
    if (current !== json) {
      failed = true;
      console.error(`✗ ${name}.json is out of date — run \`pnpm packs:generate\``);
      continue;
    }
    console.log(`✓ ${name}.json up to date (${result.pack.workflows.length} workflows)`);
  } else {
    writeFileSync(out, json);
    console.log(`✓ ${name}.json written (${result.pack.workflows.length} workflows)`);
  }
}

if (warningCount > 0) {
  console.warn(`\n${warningCount} integrity warning(s) — dead signatures/rules, see packs_status.`);
}
if (failed) process.exit(1);
