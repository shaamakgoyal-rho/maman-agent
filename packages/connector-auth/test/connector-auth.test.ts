import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  buildAuthorizationUrl,
  connectionHealth,
  envelopeDecrypt,
  envelopeEncrypt,
  exchangeCode,
  generatePkce,
  PROVIDERS,
  refreshTokens,
  signState,
  verifyState,
  type TokenTransport,
} from "../src/index.js";

const SECRET = "x".repeat(48);
const NOW = Date.parse("2026-07-17T18:00:00.000Z");

function payload(overrides = {}) {
  return {
    organization_id: "org-1",
    user_id: "user-1",
    provider: "salesforce",
    redirect_uri: "https://api.local/v1/connectors/salesforce/callback",
    nonce: "n-1",
    issued_at_ms: NOW,
    ...overrides,
  };
}

describe("provider registry", () => {
  it("includes all six providers with minimum scopes", () => {
    expect(Object.keys(PROVIDERS).sort()).toEqual([
      "gmail",
      "google_calendar",
      "google_sheets",
      "hubspot",
      "salesforce",
      "slack",
    ]);
  });

  it("gmail scopes permit metadata and drafts, never send", () => {
    expect(PROVIDERS.gmail.scopes.join(" ")).not.toMatch(/gmail.send|mail.google.com\/$/);
    expect(PROVIDERS.gmail.scopes.some((s) => s.includes("compose"))).toBe(true);
  });
});

describe("OAuth state (signed, single-use semantics, 10min expiry)", () => {
  it("round-trips a valid state", () => {
    const state = signState(payload(), SECRET);
    const result = verifyState(state, SECRET, NOW + 1000);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.payload.provider).toBe("salesforce");
  });

  it("rejects tampering, wrong secret, and expiry", () => {
    const state = signState(payload(), SECRET);
    expect(verifyState(state + "x", SECRET, NOW).valid).toBe(false);
    expect(verifyState(state, "y".repeat(48), NOW).valid).toBe(false);
    expect(verifyState(state, SECRET, NOW + 11 * 60 * 1000)).toEqual({
      valid: false,
      reason: "expired",
    });
    expect(verifyState("garbage", SECRET, NOW).valid).toBe(false);
  });
});

describe("PKCE + authorization URL", () => {
  it("generates S256 challenges and embeds them for PKCE providers", () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    const url = buildAuthorizationUrl({
      provider: "salesforce",
      client_id: "cid",
      redirect_uri: "https://api.local/cb",
      state: "st",
      pkce_challenge: challenge,
    })!;
    expect(url).toContain("code_challenge_method=S256");
    expect(url).toContain(`code_challenge=${challenge}`);
    expect(url).toContain("scope=api+refresh_token");
  });

  it("omits PKCE for non-PKCE providers and rejects unknown providers", () => {
    const slack = buildAuthorizationUrl({
      provider: "slack",
      client_id: "cid",
      redirect_uri: "https://api.local/cb",
      state: "st",
      pkce_challenge: "ignored",
    })!;
    expect(slack).not.toContain("code_challenge");
    expect(
      buildAuthorizationUrl({ provider: "nope", client_id: "c", redirect_uri: "r", state: "s" }),
    ).toBeNull();
  });
});

describe("token exchange against a mock provider", () => {
  const okTransport: TokenTransport = async (_url, form) => ({
    status: 200,
    body: {
      access_token: `at_${form["grant_type"]}`,
      refresh_token: "rt_1",
      expires_in: 3600,
    },
  });

  it("exchanges an authorization code with PKCE verifier", async () => {
    let capturedForm: Record<string, string> = {};
    const transport: TokenTransport = async (url, form) => {
      capturedForm = form;
      return okTransport(url, form);
    };
    const result = await exchangeCode(
      {
        provider: "salesforce",
        client_id: "cid",
        code: "auth-code",
        redirect_uri: "https://api.local/cb",
        pkce_verifier: "verifier-123",
      },
      transport,
    );
    expect(result.ok).toBe(true);
    expect(capturedForm["code_verifier"]).toBe("verifier-123");
    if (result.ok) expect(result.tokens.access_token).toBe("at_authorization_code");
  });

  it("refreshes tokens", async () => {
    const result = await refreshTokens(
      { provider: "salesforce", client_id: "cid", refresh_token: "rt_1" },
      okTransport,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tokens.access_token).toBe("at_refresh_token");
  });

  it("surfaces provider errors and invalid responses as structured failures", async () => {
    const failing: TokenTransport = async () => ({ status: 429, body: { error: "rate_limited" } });
    const bad: TokenTransport = async () => ({ status: 200, body: { nope: true } });
    expect(
      await exchangeCode(
        { provider: "salesforce", client_id: "c", code: "x", redirect_uri: "r" },
        failing,
      ),
    ).toEqual({ ok: false, error: "provider_error", status: 429 });
    expect(
      await exchangeCode(
        { provider: "salesforce", client_id: "c", code: "x", redirect_uri: "r" },
        bad,
      ),
    ).toEqual({ ok: false, error: "invalid_response" });
  });
});

describe("credential vault (envelope encryption)", () => {
  const master = randomBytes(32);
  const tokens = { access_token: "SECRET_ACCESS", refresh_token: "SECRET_REFRESH" };
  const aad = { organization_id: "org-1", provider: "salesforce" };

  it("round-trips and never stores plaintext", () => {
    const envelope = envelopeEncrypt(tokens, master, aad);
    expect(envelope.ciphertext.toString()).not.toContain("SECRET_ACCESS");
    expect(envelope.encrypted_data_key.toString()).not.toContain("SECRET");
    expect(envelopeDecrypt(envelope, master, aad)).toEqual(tokens);
  });

  it("binding to org+provider prevents cross-tenant credential reuse", () => {
    const envelope = envelopeEncrypt(tokens, master, aad);
    expect(() =>
      envelopeDecrypt(envelope, master, { organization_id: "org-2", provider: "salesforce" }),
    ).toThrow();
    expect(() =>
      envelopeDecrypt(envelope, master, { organization_id: "org-1", provider: "hubspot" }),
    ).toThrow();
  });

  it("wrong master key fails; short keys rejected", () => {
    const envelope = envelopeEncrypt(tokens, master, aad);
    expect(() => envelopeDecrypt(envelope, randomBytes(32), aad)).toThrow();
    expect(() => envelopeEncrypt(tokens, randomBytes(16), aad)).toThrow(/32 bytes/);
  });

  it("each credential gets a unique data key", () => {
    const a = envelopeEncrypt(tokens, master, aad);
    const b = envelopeEncrypt(tokens, master, aad);
    expect(a.encrypted_data_key.equals(b.encrypted_data_key)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });
});

describe("connection health", () => {
  it("derives health without exposing tokens", () => {
    expect(
      connectionHealth({ revoked_at: "2026-07-01T00:00:00Z", expires_at: null, now_ms: NOW }),
    ).toBe("revoked");
    expect(connectionHealth({ revoked_at: null, expires_at: null, now_ms: NOW })).toBe("connected");
    expect(
      connectionHealth({ revoked_at: null, expires_at: "2026-07-17T17:00:00Z", now_ms: NOW }),
    ).toBe("expired");
    expect(
      connectionHealth({ revoked_at: null, expires_at: "2026-07-18T00:00:00Z", now_ms: NOW }),
    ).toBe("expiring_soon");
    expect(
      connectionHealth({ revoked_at: null, expires_at: "2026-09-01T00:00:00Z", now_ms: NOW }),
    ).toBe("connected");
  });
});
