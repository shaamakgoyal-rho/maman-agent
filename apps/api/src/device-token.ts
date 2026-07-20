import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { OrganizationRole } from "@maman/contracts";

/**
 * Scoped device tokens: an HMAC-signed, expiring credential minted at enrollment
 * and presented by the desktop app as `Authorization: Bearer d1.<body>.<mac>`.
 * The `d1.` scheme prefix lets the authenticator distinguish device tokens from
 * WorkOS user bearer tokens without trial verification. Tokens are stateless to
 * verify but every session is also recorded in `device_sessions` so rotation
 * and revocation are authoritative.
 */

export const DEVICE_TOKEN_PREFIX = "d1";
export const DEVICE_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const payloadSchema = z
  .object({
    device_id: z.string().uuid(),
    organization_id: z.string().uuid(),
    user_id: z.string().uuid(),
    role: z.enum(["member", "manager", "org_admin", "security_admin", "billing_admin"]),
    token_family_id: z.string().uuid(),
    issued_at_ms: z.number().int(),
    expires_at_ms: z.number().int(),
  })
  .strict();
export type DeviceTokenPayload = z.infer<typeof payloadSchema>;

export function signDeviceToken(payload: DeviceTokenPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payloadSchema.parse(payload))).toString("base64url");
  const mac = createHmac("sha256", secret)
    .update(`${DEVICE_TOKEN_PREFIX}.${body}`)
    .digest("base64url");
  return `${DEVICE_TOKEN_PREFIX}.${body}.${mac}`;
}

export type DeviceTokenVerification =
  | { valid: true; payload: DeviceTokenPayload }
  | { valid: false; reason: "bad_format" | "bad_signature" | "expired" | "bad_payload" };

export function isDeviceToken(token: string): boolean {
  return token.startsWith(`${DEVICE_TOKEN_PREFIX}.`);
}

export function verifyDeviceToken(
  token: string,
  secret: string,
  nowMs: number,
): DeviceTokenVerification {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== DEVICE_TOKEN_PREFIX) {
    return { valid: false, reason: "bad_format" };
  }
  const [, body, mac] = parts;
  const expected = createHmac("sha256", secret)
    .update(`${DEVICE_TOKEN_PREFIX}.${body}`)
    .digest("base64url");
  const a = Buffer.from(expected);
  const b = Buffer.from(mac!);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { valid: false, reason: "bad_signature" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body!, "base64url").toString());
  } catch {
    return { valid: false, reason: "bad_payload" };
  }
  const payload = payloadSchema.safeParse(parsed);
  if (!payload.success) return { valid: false, reason: "bad_payload" };
  if (nowMs >= payload.data.expires_at_ms) return { valid: false, reason: "expired" };
  return { valid: true, payload: payload.data };
}

/** SHA-256 hex of a token, for storage in device_sessions (never the token). */
export function deviceTokenRole(role: string): OrganizationRole {
  return role as OrganizationRole;
}
