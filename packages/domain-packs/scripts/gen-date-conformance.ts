/**
 * Generates domain/date-conformance.json from the TypeScript date extractor.
 *
 * Same anti-drift contract as classifier-conformance.json, and needed for the
 * same reason: the readable specification lives in TypeScript, but the code that
 * actually reads a live label runs in SWIFT, inside the observer boundary. Two
 * implementations of "is 03/04/2026 ambiguous" would drift silently, and the
 * failure mode is a renewal card fired for the wrong month.
 *
 * Both the TS suite and the Swift test runner assert against this file.
 *
 * Run: pnpm packs:date-conformance   Check: pnpm packs:date-conformance --check
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractDateIso } from "../src/extract-date.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const OUT = join(ROOT, "domain", "date-conformance.json");

/**
 * Every case is text of the shape a label actually has. Names describe the
 * PROPERTY under test so a Swift failure message says what broke.
 */
const CASES: Array<{ name: string; text: string }> = [
  // Unambiguous: year first.
  { name: "iso year first", text: "Term end 2026-08-25" },
  { name: "year first with slashes", text: "expires 2026/08/25" },
  { name: "year first with dots", text: "expires 2026.08.25" },
  { name: "year first single digit parts", text: "2026-1-5" },
  { name: "year first impossible day", text: "2026-02-30" },
  { name: "year first impossible month", text: "2026-13-01" },
  { name: "real leap day", text: "2028-02-29" },
  { name: "fake leap day", text: "2027-02-29" },
  { name: "year below plausible window", text: "1889-08-25" },
  { name: "year above plausible window", text: "2999-08-25" },

  // Month names.
  { name: "day month-name year", text: "Renewal: 25 Aug 2026" },
  { name: "day full-month year with comma", text: "Renewal: 25 August, 2026" },
  { name: "month-name day year", text: "Renewal: Aug 25, 2026" },
  { name: "month-name day year no comma", text: "Renewal: August 25 2026" },
  { name: "sept abbreviation", text: "Renewal: Sept 1, 2026" },
  { name: "ordinal suffix", text: "term end Aug 25th, 2026" },
  { name: "month name two digit year", text: "term end 25 Aug 26" },
  { name: "month name impossible day", text: "Feb 30, 2026" },
  { name: "word that is not a month", text: "25 Renewal 2026" },
  { name: "quarter is not a month", text: "Quarter 3, 2026" },

  // Bare numeric: order resolved only when a component exceeds 12.
  { name: "numeric day first resolved", text: "expires 25/08/2026" },
  { name: "numeric month first resolved", text: "expires 08/25/2026" },
  { name: "numeric ambiguous both under 13", text: "expires 03/04/2026" },
  { name: "numeric two digit year", text: "expires 25/08/26" },
  { name: "numeric impossible day", text: "31/02/2026" },
  { name: "numeric dashes", text: "expires 25-08-2026" },

  // Multiple candidates lower confidence.
  { name: "two year-first dates", text: "start 2026-01-01 term end 2026-08-25" },
  { name: "two numeric dates", text: "25/08/2026 and 26/09/2026" },

  // Nothing to read.
  { name: "empty", text: "" },
  { name: "invoice id is not a date", text: "INV-2041" },
  { name: "bare year", text: "2026" },
  { name: "amount is not a date", text: "$4,500.00" },
  { name: "no digits at all", text: "amount due" },

  // Realistic labels, including one carrying content that must not survive.
  {
    name: "label with account and email",
    text: "Northwind Traders — renewal term end 2026-08-25 (owner: dana@example.com)",
  },
  { name: "crm field summary", text: "Term End Date: 2027-03-31" },
];

const generated = CASES.map(({ name, text }) => ({
  name,
  text,
  expected: extractDateIso(text),
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
    console.error("✗ date-conformance.json is out of date — run `pnpm packs:date-conformance`");
    process.exit(1);
  }
  console.log(`✓ date-conformance.json up to date (${generated.length} cases)`);
} else {
  writeFileSync(OUT, json);
  const read = generated.filter((c) => c.expected.date !== null).length;
  console.log(`✓ date-conformance.json written (${generated.length} cases, ${read} with a date)`);
}
