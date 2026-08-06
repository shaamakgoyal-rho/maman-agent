import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildFixture } from "../scripts/generate-egress-conformance.js";

/**
 * DRIFT CONTRACT — the TypeScript half.
 *
 * `redact.ts` is the specification of the frame-egress gate, but the copy that
 * actually stands between captured pixels and the network is the Swift mirror in
 * the observer. `domain/teach-egress-conformance.json` pins the two together;
 * the Swift runner and XCTest assert every case against their implementation,
 * and this test asserts the committed fixture still matches what the TS gate
 * produces today.
 *
 * A MISSING fixture FAILS here rather than skipping — a skipped drift check is
 * indistinguishable from a passing one right up until the two sides disagree,
 * and here "disagree" means a frame the specification would have refused.
 */
const FIXTURE = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "domain",
  "teach-egress-conformance.json",
);

describe("teach-egress conformance fixture", () => {
  it("exists and matches the current TS gate byte for byte", () => {
    let committed = "";
    try {
      committed = readFileSync(FIXTURE, "utf8");
    } catch (e) {
      throw new Error(
        `teach-egress-conformance.json is unreadable (${String(e)}). ` +
          "It is a required drift contract, not an optional fixture — run `pnpm teach:egress-conformance`.",
      );
    }
    expect(committed).toBe(buildFixture());
  });

  it("covers every refusal reason at least once", () => {
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
      cases: Array<{ expected: { reason: string | null } }>;
    };
    const reasons = new Set(fixture.cases.map((c) => c.expected.reason).filter(Boolean));
    for (const reason of [
      "no_session",
      "session_expired",
      "paused",
      "unknown_app",
      "hard_denied_app",
      "private_app",
      "private_browsing",
      "secure_field_focused",
      "out_of_session_scope",
      "too_much_would_be_masked",
    ]) {
      expect([...reasons], reason).toContain(reason);
    }
  });

  it("covers every mask reason at least once", () => {
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
      cases: Array<{ expected: { masks: Array<{ reason: string }> } }>;
    };
    const reasons = new Set(fixture.cases.flatMap((c) => c.expected.masks.map((m) => m.reason)));
    for (const reason of [
      "secure_field",
      "secret_shaped_text",
      "password_manager_ui",
      "unrecognised_credential_field",
    ]) {
      expect([...reasons], reason).toContain(reason);
    }
  });
});
