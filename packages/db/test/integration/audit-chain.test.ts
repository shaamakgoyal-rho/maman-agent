import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  appendAuditEvent,
  globalCreateOrganization,
  orgFactory,
  verifyAuditChain,
} from "../../src/index.js";
import { startTestDb, type TestDb } from "./setup.js";

let db: TestDb;

/** Creates a fresh org with `n` chained audit events. Each test gets its own chain. */
async function seedChain(n: number): Promise<string> {
  const org = await globalCreateOrganization(db.client.sql, orgFactory());
  for (let i = 0; i < n; i++) {
    await appendAuditEvent(
      db.client.sql,
      { organizationId: org.id },
      {
        organization_id: org.id,
        actor_type: "system",
        actor_id: "test",
        action: `test.action.${i}`,
        resource_type: "test",
        outcome: "success",
        metadata: { index: i },
      },
    );
  }
  return org.id;
}

beforeAll(async () => {
  db = await startTestDb();
}, 180_000);

afterAll(async () => {
  await db.stop();
});

describe("audit hash chain", () => {
  it("verifies an intact chain", async () => {
    const orgId = await seedChain(5);
    const result = await verifyAuditChain(db.client.sql, { organizationId: orgId });
    expect(result).toEqual({ valid: true, event_count: 5 });
  });

  it("verifies an empty chain for an org with no events", async () => {
    const orgId = await seedChain(0);
    const result = await verifyAuditChain(db.client.sql, { organizationId: orgId });
    expect(result).toEqual({ valid: true, event_count: 0 });
  });

  it("detects a mutated event", async () => {
    const orgId = await seedChain(5);
    await db.client.sql`ALTER TABLE audit_events DISABLE TRIGGER audit_events_immutable`;
    await db.client.sql`
      UPDATE audit_events SET action = 'test.action.EVIL'
      WHERE organization_id = ${orgId} AND action = 'test.action.2'
    `;
    await db.client.sql`ALTER TABLE audit_events ENABLE TRIGGER audit_events_immutable`;

    const result = await verifyAuditChain(db.client.sql, { organizationId: orgId });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("hash_mismatch");
  });

  it("detects a deleted (missing) event as a broken link", async () => {
    const orgId = await seedChain(5);
    await db.client.sql`ALTER TABLE audit_events DISABLE TRIGGER audit_events_immutable`;
    await db.client.sql`
      DELETE FROM audit_events WHERE organization_id = ${orgId} AND action = 'test.action.1'
    `;
    await db.client.sql`ALTER TABLE audit_events ENABLE TRIGGER audit_events_immutable`;

    const result = await verifyAuditChain(db.client.sql, { organizationId: orgId });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(["broken_link", "hash_mismatch"]).toContain(result.reason);
  });

  it("detects reordered events", async () => {
    const orgId = await seedChain(4);
    // Swap occurred_at of two adjacent events to reorder the chain.
    await db.client.sql`ALTER TABLE audit_events DISABLE TRIGGER audit_events_immutable`;
    const rows = await db.client.sql<{ id: string; occurred_at: string }[]>`
      SELECT id, occurred_at FROM audit_events
      WHERE organization_id = ${orgId}
      ORDER BY occurred_at ASC LIMIT 2
    `;
    const [a, b] = rows;
    await db.client
      .sql`UPDATE audit_events SET occurred_at = ${b!.occurred_at} WHERE id = ${a!.id}`;
    await db.client
      .sql`UPDATE audit_events SET occurred_at = ${a!.occurred_at} WHERE id = ${b!.id}`;
    await db.client.sql`ALTER TABLE audit_events ENABLE TRIGGER audit_events_immutable`;

    const result = await verifyAuditChain(db.client.sql, { organizationId: orgId });
    expect(result.valid).toBe(false);
  });

  it("detects head tampering", async () => {
    const orgId = await seedChain(3);
    await db.client.sql`
      UPDATE audit_chain_heads SET latest_event_hash = 'deadbeef'
      WHERE organization_id = ${orgId}
    `;
    const result = await verifyAuditChain(db.client.sql, { organizationId: orgId });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("head_mismatch");
  });

  it("blocks UPDATE and DELETE on audit_events via trigger", async () => {
    const orgId = await seedChain(2);
    await expect(
      db.client.sql`UPDATE audit_events SET action = 'x' WHERE organization_id = ${orgId}`,
    ).rejects.toThrow(/append-only/);
    await expect(
      db.client.sql`DELETE FROM audit_events WHERE organization_id = ${orgId}`,
    ).rejects.toThrow(/append-only/);
  });

  it("chains are independent per organization", async () => {
    const orgA = await seedChain(3);
    const orgB = await seedChain(3);
    // Tamper org A only.
    await db.client.sql`
      UPDATE audit_chain_heads SET latest_event_hash = 'deadbeef' WHERE organization_id = ${orgA}
    `;
    expect((await verifyAuditChain(db.client.sql, { organizationId: orgA })).valid).toBe(false);
    expect((await verifyAuditChain(db.client.sql, { organizationId: orgB })).valid).toBe(true);
  });
});
