import { describe, expect, it } from "vitest";
import {
  canonicalAuditJson,
  looksLikeSecret,
  stepIdempotencyKey,
  uuidv7,
  type AuditEvent,
} from "../src/index.js";

describe("uuidv7", () => {
  it("produces a valid v7 UUID", () => {
    const id = uuidv7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("is time-ordered for increasing timestamps", () => {
    const a = uuidv7({ timestampMs: 1000, random: () => 0 });
    const b = uuidv7({ timestampMs: 2000, random: () => 0 });
    expect(a < b).toBe(true);
  });

  it("is deterministic with injected time and randomness", () => {
    const a = uuidv7({ timestampMs: 1721234567890, random: () => 0.5 });
    const b = uuidv7({ timestampMs: 1721234567890, random: () => 0.5 });
    expect(a).toBe(b);
  });
});

describe("looksLikeSecret", () => {
  it("flags API-key shapes", () => {
    expect(looksLikeSecret("sk-ant-api03-abcdefghijklmnop")).toBe(true);
    expect(looksLikeSecret("AKIAIOSFODNN7EXAMPLE")).toBe(true);
    expect(looksLikeSecret("ghp_" + "a".repeat(36))).toBe(true);
  });

  it("flags password assignments", () => {
    expect(looksLikeSecret("password=hunter22")).toBe(true);
    expect(looksLikeSecret("api_key: abc123def")).toBe(true);
  });

  it("flags JWTs", () => {
    expect(
      looksLikeSecret(
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9P",
      ),
    ).toBe(true);
  });

  it("does not flag ordinary business text", () => {
    expect(looksLikeSecret("Match rows by company domain")).toBe(false);
    expect(looksLikeSecret("Account Name")).toBe(false);
    expect(looksLikeSecret("https://example.my.salesforce.com")).toBe(false);
  });
});

describe("stepIdempotencyKey", () => {
  it("builds the canonical key format", () => {
    expect(
      stepIdempotencyKey({
        run_id: "r1",
        agent_version_id: "v1",
        step_id: "s1",
        capability_version: 2,
        diff_hash: "abc",
      }),
    ).toBe("r1:v1:s1:2:abc");
  });
});

describe("canonicalAuditJson", () => {
  const base: AuditEvent = {
    id: "01912345-1234-7123-8123-123456789012",
    organization_id: "01912345-1234-7123-8123-123456789013",
    actor_type: "user",
    actor_id: "u1",
    action: "agent.create",
    resource_type: "agent",
    resource_id: "a1",
    outcome: "success",
    metadata: { b: 2, a: 1 },
    occurred_at: "2026-07-17T18:00:00.000Z",
  };

  it("is stable regardless of key insertion order", () => {
    const reordered = {
      occurred_at: base.occurred_at,
      metadata: { a: 1, b: 2 },
      outcome: base.outcome,
      resource_id: base.resource_id,
      resource_type: base.resource_type,
      action: base.action,
      actor_id: base.actor_id,
      actor_type: base.actor_type,
      organization_id: base.organization_id,
      id: base.id,
    } as AuditEvent;
    expect(canonicalAuditJson(base)).toBe(canonicalAuditJson(reordered));
  });

  it("changes when any field changes", () => {
    expect(canonicalAuditJson(base)).not.toBe(canonicalAuditJson({ ...base, outcome: "denied" }));
  });

  it("omits undefined optional fields", () => {
    const { resource_id: _r, ...rest } = base;
    const json = canonicalAuditJson(rest as AuditEvent);
    expect(json.includes("resource_id")).toBe(false);
  });
});
