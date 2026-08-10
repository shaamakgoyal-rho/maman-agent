// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { accessibleName } from "../src/lib/dom-adapter.js";

/**
 * DRIFT CONTRACT — the extension lane's half.
 *
 * The other half is `packages/browser-actuator/test/accessible-name-conformance.test.ts`,
 * which asserts the SAME table against the ES5 source evaluated inside Maman's
 * own browser window. Nothing else connects the two: they share no code, only
 * this fixture.
 *
 * The name is the only handle an agent has on a control, and discovery hands the
 * agent a name it will later send back as a target. So a lane-dependent name is
 * not a cosmetic difference — it is a plan that resolves in one window and
 * refuses in the other, for a reason no one can see.
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

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("accessible-name conformance (extension lane)", () => {
  it("has a fixture with cases", () => {
    expect(fixture.cases.length).toBeGreaterThan(0);
  });

  for (const testCase of fixture.cases) {
    it(`${testCase.id} → ${JSON.stringify(testCase.expected)} (${testCase.rung})`, () => {
      document.body.innerHTML = testCase.html;
      const subject = document.querySelector(testCase.subject);
      expect(subject, `no element matched ${testCase.subject}`).not.toBeNull();
      expect(accessibleName(subject!), testCase.why ?? testCase.id).toBe(testCase.expected);
    });
  }

  it("exercises every rung, including the absence of one", () => {
    const covered = new Set(fixture.cases.map((c) => c.rung));
    for (const rung of [...fixture.rung_order, "none"]) {
      expect([...covered], rung).toContain(rung);
    }
  });
});
