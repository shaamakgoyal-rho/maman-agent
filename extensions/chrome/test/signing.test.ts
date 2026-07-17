import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  newNonce,
  newPairingToken,
  signEnvelope,
  verifyEnvelope,
  base64urlEncode,
} from "../src/lib/signing.js";

const SECRET = base64urlEncode(new Uint8Array(32).fill(7));

function envelope(overrides: Partial<Parameters<typeof signEnvelope>[0]> = {}) {
  return {
    message_id: "m-1",
    installation_id: "i-1",
    timestamp: new Date("2026-07-17T18:00:00.000Z").toISOString(),
    nonce: "n-1",
    payload: { type: "semantic_event", event: { event_type: "navigation" } },
    ...overrides,
  };
}

const NOW = Date.parse("2026-07-17T18:00:10.000Z");

describe("canonical JSON", () => {
  it("sorts keys recursively and is insertion-order independent", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}',
    );
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it("drops undefined values", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe("envelope signing and verification", () => {
  it("round-trips a valid signature", async () => {
    const signed = await signEnvelope(envelope(), SECRET);
    expect(signed.signature).toMatch(/^[0-9a-f]{64}$/);
    const result = await verifyEnvelope(signed, SECRET, { nowMs: NOW });
    expect(result).toEqual({ valid: true });
  });

  it("rejects a tampered payload", async () => {
    const signed = await signEnvelope(envelope(), SECRET);
    const tampered = {
      ...signed,
      payload: { type: "semantic_event", event: { event_type: "record_updated" } },
    };
    const result = await verifyEnvelope(tampered, SECRET, { nowMs: NOW });
    expect(result).toEqual({ valid: false, reason: "bad_signature" });
  });

  it("rejects the wrong secret", async () => {
    const signed = await signEnvelope(envelope(), SECRET);
    const wrong = base64urlEncode(new Uint8Array(32).fill(9));
    expect((await verifyEnvelope(signed, wrong, { nowMs: NOW })).valid).toBe(false);
  });

  it("rejects messages older than 60 seconds", async () => {
    const signed = await signEnvelope(envelope(), SECRET);
    const later = NOW + 61_000;
    expect(await verifyEnvelope(signed, SECRET, { nowMs: later })).toEqual({
      valid: false,
      reason: "expired",
    });
  });

  it("rejects replayed nonces", async () => {
    const signed = await signEnvelope(envelope(), SECRET);
    const seen = new Set<string>();
    expect((await verifyEnvelope(signed, SECRET, { nowMs: NOW, seenNonces: seen })).valid).toBe(
      true,
    );
    expect(await verifyEnvelope(signed, SECRET, { nowMs: NOW, seenNonces: seen })).toEqual({
      valid: false,
      reason: "replayed_nonce",
    });
  });

  it("rejects garbage timestamps", async () => {
    const signed = await signEnvelope(envelope({ timestamp: "not-a-date" }), SECRET);
    expect(await verifyEnvelope(signed, SECRET, { nowMs: NOW })).toEqual({
      valid: false,
      reason: "bad_timestamp",
    });
  });
});

describe("cross-implementation vector (matches the Rust desktop verifier)", () => {
  it("produces the frozen signature for the shared test envelope", async () => {
    const signed = await signEnvelope(
      {
        message_id: "m-1",
        installation_id: "i-1",
        timestamp: "2026-07-17T18:00:00.000Z",
        nonce: "n-1",
        payload: { type: "semantic_event", event: { event_type: "navigation" } },
      },
      SECRET,
    );
    // Same constant lives in apps/desktop/src-tauri/src/browser_bridge.rs —
    // if either implementation's canonicalization drifts, both suites fail.
    expect(signed.signature).toBe(
      "7777ebe4a55d7bcf1318cd7f79fbb917d836c84c3cd1f996d923b2cb1baa5438",
    );
  });
});

describe("token and nonce generation", () => {
  it("pairing tokens are 32 bytes base64url", () => {
    const token = newPairingToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newPairingToken()).not.toBe(token);
  });

  it("nonces are unique 16-byte hex", () => {
    const nonce = newNonce();
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(newNonce()).not.toBe(nonce);
  });
});
