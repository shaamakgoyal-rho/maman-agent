import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyEvent,
  validatePack,
  type ClassifierInput,
  type DomainPack,
} from "../src/index.js";

/**
 * Anti-drift contract. The same fixture is asserted by the Rust suite
 * (apps/desktop/src-tauri/src/domain.rs). Rust is the production classifier at
 * ingest; this TypeScript implementation is the readable specification. If
 * either changes behaviour, one of these two suites fails.
 */

const ROOT = join(import.meta.dirname, "..", "..", "..");
function pack(name: string): DomainPack {
  const r = validatePack(
    JSON.parse(readFileSync(join(ROOT, "domain", "packs", `${name}.json`), "utf8")),
  );
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.pack;
}
const packs = [pack("finops"), pack("revops")];

type Case = {
  name: string;
  input: ClassifierInput;
  expected: { domain: string; object?: string; action?: string; confidence: number } | null;
};
const cases: Case[] = JSON.parse(
  readFileSync(join(ROOT, "domain", "classifier-conformance.json"), "utf8"),
);

describe("classifier conformance fixture", () => {
  it("has cases, including both classified and unclassified outcomes", () => {
    expect(cases.length).toBeGreaterThan(5);
    expect(cases.some((c) => c.expected === null)).toBe(true);
    expect(cases.some((c) => c.expected !== null)).toBe(true);
  });

  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, testCase) => {
    expect(classifyEvent(packs, testCase.input)).toEqual(testCase.expected);
  });
});
