/**
 * Native-message authentication (spec §10 pairing protocol, step 8):
 * HMAC-SHA256 over canonical JSON containing message_id, installation_id,
 * timestamp, nonce, and payload. The Rust host and desktop verify the same
 * canonical form; messages older than 60s or with a repeated nonce are
 * rejected on the receiving side.
 */

export type SignedEnvelope = {
  message_id: string;
  installation_id: string;
  timestamp: string;
  nonce: string;
  payload: unknown;
  signature: string;
};

export const MESSAGE_MAX_AGE_MS = 60_000;

/** Canonical JSON: recursively sorted object keys, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(",")}}`;
}

export function signingInput(envelope: Omit<SignedEnvelope, "signature">): string {
  return canonicalJson({
    message_id: envelope.message_id,
    installation_id: envelope.installation_id,
    timestamp: envelope.timestamp,
    nonce: envelope.nonce,
    payload: envelope.payload,
  });
}

async function hmacKey(secretBase64url: string): Promise<CryptoKey> {
  const raw = base64urlDecode(secretBase64url);
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export async function signEnvelope(
  envelope: Omit<SignedEnvelope, "signature">,
  secretBase64url: string,
): Promise<SignedEnvelope> {
  const key = await hmacKey(secretBase64url);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signingInput(envelope)),
  );
  return { ...envelope, signature: hex(new Uint8Array(signature)) };
}

export async function verifyEnvelope(
  envelope: SignedEnvelope,
  secretBase64url: string,
  opts: { nowMs?: number; seenNonces?: Set<string> } = {},
): Promise<{ valid: true } | { valid: false; reason: string }> {
  const now = opts.nowMs ?? Date.now();
  const ts = Date.parse(envelope.timestamp);
  if (Number.isNaN(ts)) return { valid: false, reason: "bad_timestamp" };
  if (Math.abs(now - ts) > MESSAGE_MAX_AGE_MS) return { valid: false, reason: "expired" };
  if (opts.seenNonces?.has(envelope.nonce)) return { valid: false, reason: "replayed_nonce" };

  const key = await hmacKey(secretBase64url);
  const expected = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signingInput(envelope)),
  );
  const ok = timingSafeEqualHex(hex(new Uint8Array(expected)), envelope.signature);
  if (!ok) return { valid: false, reason: "bad_signature" };
  opts.seenNonces?.add(envelope.nonce);
  return { valid: true };
}

export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return hex(bytes);
}

export function newPairingToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64urlEncode(bytes);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function base64urlDecode(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
