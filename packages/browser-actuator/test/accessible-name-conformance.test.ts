/**
 * @vitest-environment jsdom
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ACCESSIBLE_NAME_SOURCE, AGENT_PAGE_SCRIPT } from "../src/inpage.js";

/**
 * DRIFT CONTRACT — the own-window lane's half.
 *
 * The other half is `extensions/chrome/test/accessible-name-conformance.test.ts`,
 * which asserts the SAME table against `accessibleName()` in the extension's DOM
 * adapter. The two implementations share no code — one is TypeScript against a
 * live `Element`, this one is ES5 source evaluated inside a page Maman does not
 * control — so this fixture is the only thing holding them together.
 *
 * The name is evaluated the way the host evaluates it, not read off the source:
 * a rung that typechecks but throws inside a document would still pass a
 * string-inspection test, and the whole point of this module is behaviour in a
 * real document.
 *
 * A MISSING fixture FAILS here rather than skipping: a skipped drift check is
 * indistinguishable from a passing one right up until the two sides disagree.
 */
const FIXTURE_PATH = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "domain",
  "accessible-name-conformance.json",
);

interface Fixture {
  rung_order: string[];
  cases: Array<{
    id: string;
    html: string;
    subject: string;
    expected: string;
    rung: string;
    why?: string;
  }>;
}

function loadFixture(): Fixture {
  let raw = "";
  try {
    raw = readFileSync(FIXTURE_PATH, "utf8");
  } catch (e) {
    throw new Error(
      `accessible-name-conformance.json is unreadable (${String(e)}). ` +
        "It is a required drift contract, not an optional fixture.",
    );
  }
  return JSON.parse(raw) as Fixture;
}

const fixture = loadFixture();

/**
 * jsdom globals, typed locally ON PURPOSE — `@maman/browser-actuator` compiles
 * without the DOM lib, and being unable to reference a live document is what
 * keeps the decision core deciding against plain data. See `inpage.test.ts`.
 */
const doc = (
  globalThis as unknown as {
    document: { body: { innerHTML: string }; querySelector(sel: string): unknown };
  }
).document;
const evaluateInPage = (globalThis as unknown as { eval: (code: string) => unknown }).eval;

/** The page's own `nameOf`, evaluated in the page realm exactly as the host does. */
const nameOf = evaluateInPage(`(${ACCESSIBLE_NAME_SOURCE})`) as (el: unknown) => string;

beforeEach(() => {
  doc.body.innerHTML = "";
});

describe("accessible-name conformance (own-window lane)", () => {
  it("has a fixture with cases", () => {
    expect(fixture.cases.length).toBeGreaterThan(0);
  });

  it("is the source the page script actually runs, not a second copy", () => {
    expect(AGENT_PAGE_SCRIPT).toContain(ACCESSIBLE_NAME_SOURCE);
  });

  for (const testCase of fixture.cases) {
    it(`${testCase.id} → ${JSON.stringify(testCase.expected)} (${testCase.rung})`, () => {
      doc.body.innerHTML = testCase.html;
      const subject = doc.querySelector(testCase.subject);
      expect(subject, `no element matched ${testCase.subject}`).not.toBeNull();
      expect(nameOf(subject), testCase.why ?? testCase.id).toBe(testCase.expected);
    });
  }

  it("exercises every rung, including the absence of one", () => {
    const covered = new Set(fixture.cases.map((c) => c.rung));
    for (const rung of [...fixture.rung_order, "none"]) {
      expect([...covered], rung).toContain(rung);
    }
  });
});
