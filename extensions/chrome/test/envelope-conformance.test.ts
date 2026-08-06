import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalJson, signEnvelope, signingInput, verifyEnvelope } from "../src/lib/signing.js";

/**
 * DRIFT CONTRACT — the extension's half.
 *
 * The desktop (Rust) signs the envelopes that carry a pushed browser action; this
 * code verifies them. Nothing else connects the two implementations, so a change to
 * canonical JSON or to the set of signed fields on either side would break
 * actuation with no other symptom. Both sides assert against this one committed
 * fixture, whose signature came from a third independent implementation.
 *
 * A MISSING fixture FAILS here rather than skipping: a skipped drift check is
 * indistinguishable from a passing one right up until the two sides disagree.
 */
const FIXTURE_PATH = fileURLToPath(
  new URL("../../../domain/browser-envelope-conformance.json", import.meta.url),
);

type Fixture = {
  secret_b64url: string;
  signing_input: string;
  envelope: {
    message_id: string;
    installation_id: string;
    timestamp: string;
    nonce: string;
    payload: unknown;
    signature: string;
  };
};

function loadFixture(): Fixture {
  try {
    return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture;
  } catch (e) {
    throw new Error(
      `browser-envelope-conformance.json is unreadable (${String(e)}). ` +
        "It is a required drift contract, not an optional fixture.",
    );
  }
}

describe("signed envelope cross-language conformance", () => {
  const fixture = loadFixture();
  const { envelope, secret_b64url: secret } = fixture;

  it("builds a byte-identical canonical signing input", () => {
    expect(signingInput(envelope)).toBe(fixture.signing_input);
  });

  it("verifies an envelope the desktop signed", async () => {
    const verdict = await verifyEnvelope(envelope, secret, {
      nowMs: Date.parse(envelope.timestamp),
      seenNonces: new Set(),
    });
    expect(verdict).toEqual({ valid: true });
  });

  it("reproduces the same signature when signing the same inputs", async () => {
    const resigned = await signEnvelope(
      {
        message_id: envelope.message_id,
        installation_id: envelope.installation_id,
        timestamp: envelope.timestamp,
        nonce: envelope.nonce,
        payload: envelope.payload,
      },
      secret,
    );
    expect(resigned.signature).toBe(envelope.signature);
  });

  it("rejects the fixture once a single payload byte changes", async () => {
    const payload = structuredClone(envelope.payload) as {
      request: { action: { value: string } };
    };
    payload.request.action.value = "2027-01-01";
    const verdict = await verifyEnvelope({ ...envelope, payload }, secret, {
      nowMs: Date.parse(envelope.timestamp),
      seenNonces: new Set(),
    });
    expect(verdict).toEqual({ valid: false, reason: "bad_signature" });
  });

  it("sorts keys recursively, not just at the top level", () => {
    // The fixture payload is nested three deep with keys that are unsorted as
    // written, so a shallow-only sort produces a different string and fails here.
    const canonical = canonicalJson(envelope.payload);
    expect(fixture.signing_input).toContain(canonical);
    expect(canonical).toContain('"action":{"expect_current"');
    expect(canonical.indexOf('"kind"')).toBeLessThan(canonical.indexOf('"target"'));
  });
});
