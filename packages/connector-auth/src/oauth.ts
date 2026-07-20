import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { getProvider } from "./providers.js";

/**
 * OAuth 2.0 Authorization Code + PKCE flow primitives (Connector Broker).
 * State is signed, single-use, bound to org/user/device/provider/redirect,
 * and expires after ten minutes. Tokens NEVER leave the server side.
 */

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

const statePayloadSchema = z
  .object({
    organization_id: z.string(),
    user_id: z.string(),
    device_public_id: z.string().optional(),
    provider: z.string(),
    redirect_uri: z.string(),
    nonce: z.string(),
    issued_at_ms: z.number().int(),
  })
  .strict();
export type OAuthStatePayload = z.infer<typeof statePayloadSchema>;

export function signState(payload: OAuthStatePayload, signingSecret: string): string {
  const body = Buffer.from(JSON.stringify(statePayloadSchema.parse(payload))).toString("base64url");
  const mac = createHmac("sha256", signingSecret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export type StateVerification =
  | { valid: true; payload: OAuthStatePayload }
  | { valid: false; reason: "bad_format" | "bad_signature" | "expired" | "bad_payload" };

export function verifyState(
  state: string,
  signingSecret: string,
  nowMs: number,
): StateVerification {
  const [body, mac] = state.split(".");
  if (!body || !mac) return { valid: false, reason: "bad_format" };
  const expected = createHmac("sha256", signingSecret).update(body).digest("base64url");
  const a = Buffer.from(expected);
  const b = Buffer.from(mac);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { valid: false, reason: "bad_signature" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString());
  } catch {
    return { valid: false, reason: "bad_payload" };
  }
  const payload = statePayloadSchema.safeParse(parsed);
  if (!payload.success) return { valid: false, reason: "bad_payload" };
  if (nowMs - payload.data.issued_at_ms > OAUTH_STATE_TTL_MS) {
    return { valid: false, reason: "expired" };
  }
  return { valid: true, payload: payload.data };
}

export function buildAuthorizationUrl(input: {
  provider: string;
  client_id: string;
  redirect_uri: string;
  state: string;
  pkce_challenge?: string;
}): string | null {
  const provider = getProvider(input.provider);
  if (!provider) return null;
  const url = new URL(provider.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.client_id);
  url.searchParams.set("redirect_uri", input.redirect_uri);
  url.searchParams.set("scope", provider.scopes.join(" "));
  url.searchParams.set("state", input.state);
  if (provider.supports_pkce && input.pkce_challenge) {
    url.searchParams.set("code_challenge", input.pkce_challenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}

// ---- token exchange against an injectable HTTP transport (mockable) ----

export type TokenResponse = {
  access_token: string;
  refresh_token?: string | undefined;
  expires_in?: number | undefined;
  scope?: string | undefined;
};

export type TokenTransport = (
  tokenEndpoint: string,
  form: Record<string, string>,
) => Promise<{ status: number; body: unknown }>;

/** Production token transport: form-urlencoded POST over global fetch. */
export function createConnectorTokenTransport(): TokenTransport {
  return async (tokenEndpoint, form) => {
    const res = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams(form).toString(),
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  };
}

const tokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    refresh_token: z.string().optional(),
    expires_in: z.number().optional(),
    scope: z.string().optional(),
  })
  .passthrough();

export type ExchangeResult =
  | { ok: true; tokens: TokenResponse }
  | { ok: false; error: "provider_error" | "invalid_response"; status?: number };

export async function exchangeCode(
  input: {
    provider: string;
    client_id: string;
    client_secret?: string;
    code: string;
    redirect_uri: string;
    pkce_verifier?: string;
  },
  transport: TokenTransport,
): Promise<ExchangeResult> {
  const provider = getProvider(input.provider);
  if (!provider) return { ok: false, error: "provider_error" };
  const form: Record<string, string> = {
    grant_type: "authorization_code",
    client_id: input.client_id,
    code: input.code,
    redirect_uri: input.redirect_uri,
  };
  if (provider.supports_pkce && input.pkce_verifier) form["code_verifier"] = input.pkce_verifier;
  if (input.client_secret) form["client_secret"] = input.client_secret;

  const response = await transport(provider.token_endpoint, form);
  if (response.status !== 200)
    return { ok: false, error: "provider_error", status: response.status };
  const parsed = tokenResponseSchema.safeParse(response.body);
  if (!parsed.success) return { ok: false, error: "invalid_response" };
  return { ok: true, tokens: parsed.data };
}

export async function refreshTokens(
  input: { provider: string; client_id: string; client_secret?: string; refresh_token: string },
  transport: TokenTransport,
): Promise<ExchangeResult> {
  const provider = getProvider(input.provider);
  if (!provider) return { ok: false, error: "provider_error" };
  const form: Record<string, string> = {
    grant_type: "refresh_token",
    client_id: input.client_id,
    refresh_token: input.refresh_token,
  };
  if (input.client_secret) form["client_secret"] = input.client_secret;
  const response = await transport(provider.token_endpoint, form);
  if (response.status !== 200)
    return { ok: false, error: "provider_error", status: response.status };
  const parsed = tokenResponseSchema.safeParse(response.body);
  if (!parsed.success) return { ok: false, error: "invalid_response" };
  return { ok: true, tokens: parsed.data };
}
