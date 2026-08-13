import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EXTENSION_ID, EXTENSION_PUBLIC_KEY, manifestDefinition } from "../manifest.config.js";

/**
 * THE ID IN THE MANIFEST MUST BE THE ID CHROME COMPUTES.
 *
 * The desktop app writes the native-messaging manifest's `allowed_origins`
 * from `EXTENSION_ID` without ever asking the user. If that constant and the
 * pinned public key ever disagree, Chrome refuses to launch the host and the
 * relay lane dies silently — the exact failure this pinning exists to end. So
 * the id is DERIVED here, by Chrome's own algorithm, and compared.
 */
function chromeExtensionId(publicKeyBase64: string): string {
  const der = Buffer.from(publicKeyBase64, "base64");
  const digest = createHash("sha256").update(der).digest().subarray(0, 16);
  let id = "";
  for (const byte of digest) {
    // Each nibble maps to 'a'..'p' — Chrome's mpdecimal-style encoding.
    id += String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 0x0f));
  }
  return id;
}

describe("the extension's identity is pinned and self-consistent", () => {
  it("EXTENSION_ID is exactly what Chrome derives from the pinned key", () => {
    expect(chromeExtensionId(EXTENSION_PUBLIC_KEY)).toBe(EXTENSION_ID);
  });

  it("is 32 characters in Chrome's a–p alphabet", () => {
    expect(EXTENSION_ID).toMatch(/^[a-p]{32}$/);
  });

  it("the manifest actually ships the key, so the id does not drift with load path", () => {
    expect(manifestDefinition.key).toBe(EXTENSION_PUBLIC_KEY);
  });

  it("the pinned key is a public SPKI blob — no private material is committed", () => {
    const der = Buffer.from(EXTENSION_PUBLIC_KEY, "base64");
    // A 2048-bit RSA SubjectPublicKeyInfo is 294 bytes and starts 0x30 0x82.
    expect(der.length).toBeGreaterThan(160);
    expect(der[0]).toBe(0x30);
    // Anything PEM-private-shaped would fail this and must never appear here.
    expect(EXTENSION_PUBLIC_KEY).not.toContain("PRIVATE");
  });
});
