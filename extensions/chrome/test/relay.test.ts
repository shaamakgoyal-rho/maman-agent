import { describe, expect, it, vi } from "vitest";
import { signEnvelope, verifyEnvelope, MESSAGE_MAX_AGE_MS } from "../src/lib/signing.js";
import { handleRelayMessage, RelayNonceCache, type RelayDeps } from "../src/lib/relay.js";

// A test vector, not a credential: 32 zero bytes, base64url. It protects nothing.
const SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER_SECRET = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
const NOW = Date.parse("2026-08-05T12:00:00.000Z");

const REQUEST = {
  schema_version: 1,
  type: "browser_action_request",
  request_id: "018f0000-0000-7000-8000-000000000001",
  run_id: "018f0000-0000-7000-8000-000000000002",
  step_id: "step-1",
  action: { kind: "read_field", target: { role: "textbox", name: "Close date" } },
};

async function pushEnvelope(
  payload: unknown,
  secret = SECRET,
  over: { nonce?: string; timestamp?: string } = {},
) {
  return signEnvelope(
    {
      message_id: "018f0000-0000-7000-8000-0000000000aa",
      installation_id: "install-1",
      timestamp: over.timestamp ?? new Date(NOW).toISOString(),
      nonce: over.nonce ?? "nonce-1",
      payload,
    },
    secret,
  );
}

function deps(over: Partial<RelayDeps> = {}): RelayDeps {
  return {
    sharedSecret: async () => SECRET,
    verify: (envelope, secret, opts) => verifyEnvelope(envelope, secret, opts),
    perform: vi.fn(async () => ({ ok: true as const, relayed: true })),
    post: vi.fn(),
    now: () => NOW,
    ...over,
  };
}

describe("handleRelayMessage", () => {
  it("performs a verified action request and posts the answer back", async () => {
    const d = deps();
    const envelope = await pushEnvelope({ type: "browser_action_request", request: REQUEST });
    expect(await handleRelayMessage(envelope, new RelayNonceCache(), d)).toBe("answered");
    expect(d.perform).toHaveBeenCalledWith(REQUEST);
    expect(d.post).toHaveBeenCalledWith({ ok: true, relayed: true });
  });

  it("ignores the host's own acks, which arrive on the same port", async () => {
    const d = deps();
    for (const ack of [{ ok: true }, { ok: false, error: "origin_denied" }, null, "hi", 7]) {
      expect(await handleRelayMessage(ack, new RelayNonceCache(), d)).toBe("ignored");
    }
    expect(d.perform).not.toHaveBeenCalled();
    expect(d.post).not.toHaveBeenCalled();
  });

  it("drops a forged envelope SILENTLY — no action, and no reply to probe with", async () => {
    const d = deps();
    const forged = await pushEnvelope(
      { type: "browser_action_request", request: REQUEST },
      OTHER_SECRET,
    );
    expect(await handleRelayMessage(forged, new RelayNonceCache(), d)).toBe("unverified");
    expect(d.perform).not.toHaveBeenCalled();
    expect(d.post).not.toHaveBeenCalled();
  });

  it("drops an envelope whose payload was swapped after signing", async () => {
    const d = deps();
    const envelope = await pushEnvelope({ type: "browser_action_request", request: REQUEST });
    const tampered = {
      ...envelope,
      payload: {
        type: "browser_action_request",
        request: {
          ...REQUEST,
          action: {
            kind: "click_control",
            target: { role: "button", name: "Delete" },
            confirm_name: "Delete",
          },
        },
      },
    };
    expect(await handleRelayMessage(tampered, new RelayNonceCache(), d)).toBe("unverified");
    expect(d.perform).not.toHaveBeenCalled();
  });

  it("performs nothing when unpaired, because nothing could be verified", async () => {
    const d = deps({ sharedSecret: async () => undefined });
    const envelope = await pushEnvelope({ type: "browser_action_request", request: REQUEST });
    expect(await handleRelayMessage(envelope, new RelayNonceCache(), d)).toBe("not_paired");
    expect(d.perform).not.toHaveBeenCalled();
  });

  it("verifies but does not act on a payload that is not an action request", async () => {
    const d = deps();
    for (const payload of [
      { type: "something_else" },
      { type: "browser_action_result", result: {} },
      null,
      "text",
    ]) {
      const envelope = await pushEnvelope(payload);
      expect(await handleRelayMessage(envelope, new RelayNonceCache(), d)).toBe("not_an_action");
    }
    expect(d.perform).not.toHaveBeenCalled();
  });

  it("refuses a replay of the same push", async () => {
    const d = deps();
    const nonces = new RelayNonceCache();
    const envelope = await pushEnvelope({ type: "browser_action_request", request: REQUEST });
    expect(await handleRelayMessage(envelope, nonces, d)).toBe("answered");
    expect(await handleRelayMessage(envelope, nonces, d)).toBe("unverified");
    expect(d.perform).toHaveBeenCalledTimes(1);
  });

  it("refuses a push from outside the freshness window", async () => {
    const d = deps();
    const stale = await pushEnvelope({ type: "browser_action_request", request: REQUEST }, SECRET, {
      timestamp: new Date(NOW - MESSAGE_MAX_AGE_MS - 1).toISOString(),
    });
    expect(await handleRelayMessage(stale, new RelayNonceCache(), d)).toBe("unverified");
  });

  it("distinguishes two different pushes rather than treating the second as a replay", async () => {
    const d = deps();
    const nonces = new RelayNonceCache();
    const first = await pushEnvelope({ type: "browser_action_request", request: REQUEST });
    const second = await pushEnvelope(
      { type: "browser_action_request", request: REQUEST },
      SECRET,
      {
        nonce: "nonce-2",
      },
    );
    expect(await handleRelayMessage(first, nonces, d)).toBe("answered");
    expect(await handleRelayMessage(second, nonces, d)).toBe("answered");
    expect(d.perform).toHaveBeenCalledTimes(2);
  });
});

describe("RelayNonceCache", () => {
  it("forgets entries once they fall outside the window a replay could use", async () => {
    const nonces = new RelayNonceCache();
    const envelope = await pushEnvelope({ type: "browser_action_request", request: REQUEST });
    expect(await handleRelayMessage(envelope, nonces, deps())).toBe("answered");
    expect(nonces.size).toBe(1);

    // Well past the freshness window: the entry is no longer load-bearing, because
    // the timestamp check now rejects that envelope on its own.
    nonces.prune(NOW + MESSAGE_MAX_AGE_MS + 1);
    expect(nonces.size).toBe(0);

    const later = deps({ now: () => NOW + MESSAGE_MAX_AGE_MS + 1 });
    expect(await handleRelayMessage(envelope, nonces, later)).toBe("unverified");
  });

  it("keeps entries that are still inside the window", async () => {
    const nonces = new RelayNonceCache();
    const envelope = await pushEnvelope({ type: "browser_action_request", request: REQUEST });
    await handleRelayMessage(envelope, nonces, deps());
    nonces.prune(NOW + 1000);
    expect(nonces.size).toBe(1);
  });
});
