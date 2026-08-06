/**
 * The extension's end of the desktop → extension push channel.
 *
 * Until actuation the channel only ran one way, so the extension only ever SIGNED
 * envelopes. Now it also receives them, and the direction matters: the native host
 * that relays a pushed request holds no key material by design, so the only thing
 * that distinguishes a genuine request from one the host (or anything else able to
 * write to the port) invented is the desktop's HMAC.
 *
 * Therefore: an envelope that does not verify is DROPPED SILENTLY. It gets no
 * answer and no error, because replying would tell an unauthenticated sender which
 * of its guesses were closer.
 */
import { MESSAGE_MAX_AGE_MS, type SignedEnvelope } from "./signing.js";

export type RelayVerdict =
  /** Not an envelope at all — the host's own acks come down the same port. */
  | "ignored"
  /** Bad signature, stale timestamp, or a replayed nonce. */
  | "unverified"
  /** Verified, but not an action request. */
  | "not_an_action"
  /** No shared secret: nothing can be verified, so nothing is performed. */
  | "not_paired"
  /** Performed (or refused by the executor) and answered. */
  | "answered";

export interface RelayDeps {
  sharedSecret(): Promise<string | undefined>;
  verify(
    envelope: SignedEnvelope,
    secret: string,
    opts: { nowMs: number; seenNonces: Set<string> },
  ): Promise<{ valid: true } | { valid: false; reason: string }>;
  /** Runs the request and returns the signed result envelope to send back. */
  perform(request: unknown): Promise<Record<string, unknown> | { ok: false; error: string }>;
  post(message: unknown): void;
  now(): number;
}

/**
 * Nonces seen recently, so a captured push cannot be replayed inside the 60s
 * timestamp window that `verifyEnvelope` allows.
 *
 * Pruned by age rather than capped by size: a size cap would have to forget its
 * oldest entries, and the oldest entries are exactly the ones still inside the
 * window when traffic is heavy.
 */
export class RelayNonceCache {
  private readonly seenAt = new Map<string, number>();
  private readonly seen = new Set<string>();

  prune(nowMs: number): void {
    for (const [nonce, at] of this.seenAt) {
      if (nowMs - at > MESSAGE_MAX_AGE_MS) {
        this.seenAt.delete(nonce);
        this.seen.delete(nonce);
      }
    }
  }

  /** The set `verifyEnvelope` checks and adds to. */
  get set(): Set<string> {
    return this.seen;
  }

  record(nonce: string, nowMs: number): void {
    this.seenAt.set(nonce, nowMs);
  }

  get size(): number {
    return this.seen.size;
  }
}

function isSignedEnvelope(value: unknown): value is SignedEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["message_id"] === "string" &&
    typeof v["installation_id"] === "string" &&
    typeof v["timestamp"] === "string" &&
    typeof v["nonce"] === "string" &&
    typeof v["signature"] === "string" &&
    "payload" in v
  );
}

export async function handleRelayMessage(
  raw: unknown,
  nonces: RelayNonceCache,
  deps: RelayDeps,
): Promise<RelayVerdict> {
  if (!isSignedEnvelope(raw)) return "ignored";

  const secret = await deps.sharedSecret();
  if (secret === undefined) return "not_paired";

  const now = deps.now();
  nonces.prune(now);
  const verified = await deps.verify(raw, secret, { nowMs: now, seenNonces: nonces.set });
  if (!verified.valid) return "unverified";
  nonces.record(raw.nonce, now);

  const payload = raw.payload as { type?: unknown; request?: unknown } | null;
  if (typeof payload !== "object" || payload === null) return "not_an_action";
  if (payload.type !== "browser_action_request") return "not_an_action";

  deps.post(await deps.perform(payload.request));
  return "answered";
}
