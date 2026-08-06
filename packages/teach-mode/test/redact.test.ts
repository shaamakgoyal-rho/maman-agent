import { describe, expect, it } from "vitest";
import { teachModeSessionSchema, type TeachModeSession } from "@maman/contracts";
import {
  frameEgressDecision,
  maskRegionsFor,
  MAX_MASKED_FRACTION,
  type FrameContext,
  type TextRegion,
} from "../src/index.js";

const MAMAN = "com.maman.desktop";
const SALESFORCE = "com.google.Chrome";

function session(over: Partial<TeachModeSession> = {}): TeachModeSession {
  return teachModeSessionSchema.parse({
    schema_version: 1,
    session_id: "018f0000-0000-7000-8000-000000000001",
    started_at: "2026-08-05T12:00:00.000Z",
    max_seconds: 300,
    scope_bundle_ids: [SALESFORCE],
    ...over,
  });
}

function region(text: string, over: Partial<TextRegion> = {}): TextRegion {
  return { text, x: 10, y: 20, width: 100, height: 16, ...over };
}

function context(over: Partial<FrameContext> = {}): FrameContext {
  return {
    session: session(),
    bundleId: SALESFORCE,
    elapsedSeconds: 10,
    paused: false,
    hardDeniedBundleIds: ["com.apple.keychainaccess"],
    privateBundleIds: [MAMAN],
    privateBrowsing: false,
    secureFieldFocused: false,
    textRegions: [region("Close date"), region("Account Owner")],
    ...over,
  };
}

describe("frameEgressDecision — a frame leaves the device only if everything is right", () => {
  it("sends a clean frame from an in-scope app during a live session", () => {
    expect(frameEgressDecision(context())).toEqual({ send: true, masks: [] });
  });

  it("refuses without a session, because capture is never implicit", () => {
    const ctx = context();
    delete ctx.session;
    expect(frameEgressDecision(ctx)).toEqual({ send: false, reason: "no_session" });
  });

  it("refuses once the session's own time box has elapsed", () => {
    expect(frameEgressDecision(context({ elapsedSeconds: 300 }))).toEqual({
      send: false,
      reason: "session_expired",
    });
    expect(frameEgressDecision(context({ elapsedSeconds: 299 })).send).toBe(true);
  });

  it("refuses while observation is paused", () => {
    expect(frameEgressDecision(context({ paused: true }))).toEqual({
      send: false,
      reason: "paused",
    });
  });

  it("refuses when the foreground app cannot be identified", () => {
    const missing = context();
    delete missing.bundleId;
    expect(frameEgressDecision(missing)).toEqual({ send: false, reason: "unknown_app" });
    expect(frameEgressDecision(context({ bundleId: "   " }))).toEqual({
      send: false,
      reason: "unknown_app",
    });
  });

  it("refuses a hard-denied app such as a keychain", () => {
    expect(frameEgressDecision(context({ bundleId: "com.apple.keychainaccess" }))).toEqual({
      send: false,
      reason: "hard_denied_app",
    });
  });

  it("refuses an app the user marked private", () => {
    expect(
      frameEgressDecision(
        context({ bundleId: "com.private.app", privateBundleIds: ["com.private.app"] }),
      ),
    ).toEqual({ send: false, reason: "private_app" });
  });

  it("never films Maman itself, even if the user scoped the session to it", () => {
    // The self-observation feedback loop cost 138 iterations once already.
    expect(
      frameEgressDecision(
        context({
          bundleId: MAMAN,
          session: session({ scope_bundle_ids: [MAMAN] }),
        }),
      ),
    ).toEqual({ send: false, reason: "private_app" });
  });

  it("refuses a private browsing window", () => {
    expect(frameEgressDecision(context({ privateBrowsing: true }))).toEqual({
      send: false,
      reason: "private_browsing",
    });
  });

  it("withholds the WHOLE frame while a password field has focus, not just a rectangle", () => {
    // What is being typed may be rendered somewhere a mask misses — a "show
    // password" reveal, a validation message, an autofill dropdown.
    expect(frameEgressDecision(context({ secureFieldFocused: true }))).toEqual({
      send: false,
      reason: "secure_field_focused",
    });
  });

  it("refuses an app outside the session's scope", () => {
    // Starting a session in the browser is not consent to film the mail client.
    expect(frameEgressDecision(context({ bundleId: "com.apple.mail" }))).toEqual({
      send: false,
      reason: "out_of_session_scope",
    });
  });

  it("checks the strongest reason first, so a denied app reveals nothing else", () => {
    const worst = context({
      bundleId: "com.apple.keychainaccess",
      paused: true,
      privateBrowsing: true,
      secureFieldFocused: true,
      elapsedSeconds: 9999,
    });
    // Session expiry and pause outrank app identity; the point is that a single
    // deterministic reason is reported rather than the most alarming one found.
    expect(frameEgressDecision(worst)).toEqual({ send: false, reason: "session_expired" });
  });

  it("withholds a frame that would be more mask than picture", () => {
    const mostlySecret = [
      region("api_key"),
      region("password"),
      region("token"),
      region("Close date"),
    ];
    const decision = frameEgressDecision(context({ textRegions: mostlySecret }));
    expect(decision).toEqual({ send: false, reason: "too_much_would_be_masked" });
  });

  it("sends a frame at exactly the mask threshold", () => {
    const half = [region("password"), region("Close date")];
    const decision = frameEgressDecision(context({ textRegions: half }));
    expect(decision.send).toBe(true);
    if (!decision.send) return;
    expect(decision.masks).toHaveLength(1);
    expect(half.length * MAX_MASKED_FRACTION).toBe(1);
  });

  it("sends a frame with no text at all rather than dividing by zero", () => {
    expect(frameEgressDecision(context({ textRegions: [] }))).toEqual({ send: true, masks: [] });
  });
});

describe("maskRegionsFor — what gets painted over", () => {
  it("masks an OS-reported secure input", () => {
    expect(maskRegionsFor([region("anything", { secure: true })])).toEqual([
      { x: 10, y: 20, width: 100, height: 16, reason: "secure_field" },
    ]);
  });

  it("masks a value that looks like a credential even with an innocent label", () => {
    const masks = maskRegionsFor([
      region("AKIAIOSFODNN7EXAMPLE"),
      region(`sk-ant-${"x".repeat(30)}`),
      region("-----BEGIN RSA PRIVATE KEY-----"),
    ]);
    expect(masks.map((m) => m.reason)).toEqual([
      "secret_shaped_text",
      "secret_shaped_text",
      "secret_shaped_text",
    ]);
  });

  it("masks a credential-shaped LABEL even when the value looks ordinary", () => {
    // A custom-rendered login form the OS never marked secure.
    for (const label of [
      "Password",
      "Confirm passphrase",
      "API Key",
      "Access token",
      "One-time code / OTP",
      "CVV",
      "Card number",
      "SSN",
      "IBAN",
      "Sort code",
      "Recovery code",
      "Seed phrase",
      "Private key",
    ]) {
      const masks = maskRegionsFor([region(label)]);
      expect(masks, label).toHaveLength(1);
    }
  });

  it("masks password-manager UI, which is not part of the app's own form", () => {
    const masks = maskRegionsFor([region("1Password suggestion")]);
    expect(masks[0]?.reason).toBe("password_manager_ui");
  });

  it("leaves ordinary business fields alone", () => {
    const masks = maskRegionsFor([
      region("Close date"),
      region("Account Owner"),
      region("Employees"),
      region("Annual revenue"),
      region("Invoice number"),
    ]);
    expect(masks).toEqual([]);
  });

  it("prefers the OS's secure flag over guessing from text", () => {
    const masks = maskRegionsFor([region("Close date", { secure: true })]);
    expect(masks[0]?.reason).toBe("secure_field");
  });

  it("clamps geometry so a mask can never be negative or zero-sized", () => {
    // A mask with zero area covers nothing, which would be worse than useless:
    // the frame would ship believing it had been redacted.
    const masks = maskRegionsFor([region("password", { x: -5, y: -9, width: 0.4, height: 0 })]);
    expect(masks[0]).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      reason: "unrecognised_credential_field",
    });
  });

  it("produces masks the contract accepts", async () => {
    const { maskRegionSchema } = await import("@maman/contracts");
    const masks = maskRegionsFor([
      region("password", { secure: true }),
      region("AKIAIOSFODNN7EXAMPLE"),
      region("1Password"),
      region("API key"),
    ]);
    expect(masks).toHaveLength(4);
    for (const mask of masks) {
      expect(maskRegionSchema.safeParse(mask).success).toBe(true);
    }
  });
});
