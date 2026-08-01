/**
 * Generates domain/classifier-conformance.json from the TypeScript classifier.
 *
 * The TS implementation is the readable specification; the Rust one is what runs
 * in production at ingest. This fixture is the anti-drift contract: both test
 * suites assert against it, so if either implementation changes behaviour, one
 * of them fails.
 *
 * Run: pnpm packs:conformance   Check for drift: pnpm packs:conformance --check
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  classifyEvent,
  validatePack,
  type ClassifierInput,
  type DomainPack,
} from "../src/index.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const PACKS = join(ROOT, "domain", "packs");
const OUT = join(ROOT, "domain", "classifier-conformance.json");

function pack(name: string): DomainPack {
  const r = validatePack(JSON.parse(readFileSync(join(PACKS, `${name}.json`), "utf8")));
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.pack;
}
const packs = [pack("finops"), pack("revops")];

const cases: Array<{ name: string; input: ClassifierInput }> = [
  { name: "no signal at all", input: { app_category: "other", event_type: "app_activated" } },
  {
    name: "crm record_opened by object_type",
    input: { app_category: "crm", event_type: "record_opened", object_type: "opportunity" },
  },
  { name: "object via alias", input: { event_type: "record_opened", object_type: "deal" } },
  {
    name: "label pattern hit only",
    input: { app_category: "erp", event_type: "record_opened", label_pattern_hits: ["invoice"] },
  },
  {
    name: "write event on invoice",
    input: { event_type: "value_committed", object_type: "invoice" },
  },
  { name: "read event on invoice", input: { event_type: "record_opened", object_type: "invoice" } },
  {
    name: "all evidence corroborating",
    input: {
      app_category: "erp",
      event_type: "record_opened",
      object_type: "invoice",
      label_pattern_hits: ["invoice"],
    },
  },
  {
    name: "semantic_type substring hint",
    input: { event_type: "value_committed", semantic_type: "account_name" },
  },
  {
    name: "revops quote via cpq category",
    input: { app_category: "cpq", event_type: "record_opened" },
  },
  {
    name: "ambiguous account across packs",
    input: { app_category: "crm", event_type: "record_opened", object_type: "account" },
  },
  {
    name: "bulk write on wildcard object",
    input: { event_type: "record_updated", object_type: "lead" },
  },
  {
    name: "unknown object_type",
    input: { event_type: "record_opened", object_type: "definitely_not_a_pack_object" },
  },
];

const generated = cases.map(({ name, input }) => ({
  name,
  input,
  expected: classifyEvent(packs, input),
}));
const json = `${JSON.stringify(generated, null, 2)}\n`;

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(OUT, "utf8");
  } catch {
    current = "";
  }
  if (current !== json) {
    console.error("✗ classifier-conformance.json is out of date — run `pnpm packs:conformance`");
    process.exit(1);
  }
  console.log(`✓ classifier-conformance.json up to date (${generated.length} cases)`);
} else {
  writeFileSync(OUT, json);
  const classified = generated.filter((c) => c.expected !== null).length;
  console.log(
    `✓ classifier-conformance.json written (${generated.length} cases, ${classified} classified)`,
  );
}
