import { describe, expect, it } from "vitest";
import { hashAuditEvent } from "../../src/audit.js";
import type { AuditEvent } from "@maman/contracts";

const event: AuditEvent = {
  id: "01912345-1234-7123-8123-123456789012",
  organization_id: "01912345-1234-7123-8123-123456789013",
  actor_type: "user",
  actor_id: "u1",
  action: "agent.create",
  resource_type: "agent",
  outcome: "success",
  metadata: { a: 1 },
  occurred_at: "2026-07-17T18:00:00.000Z",
};

describe("hashAuditEvent", () => {
  it("produces a stable 64-char hex hash", () => {
    const h = hashAuditEvent(null, event);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashAuditEvent(null, event)).toBe(h);
  });

  it("chains on the previous hash", () => {
    const h1 = hashAuditEvent(null, event);
    const h2 = hashAuditEvent(h1, event);
    expect(h1).not.toBe(h2);
  });

  it("changes when the event changes", () => {
    expect(hashAuditEvent(null, event)).not.toBe(
      hashAuditEvent(null, { ...event, action: "agent.delete" }),
    );
  });
});
