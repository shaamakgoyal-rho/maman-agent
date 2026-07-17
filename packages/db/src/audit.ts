import { createHash } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { auditEventSchema, canonicalAuditJson, uuidv7, type AuditEvent } from "@maman/contracts";
import { withTenant, type TenantContext } from "./tenant.js";

/**
 * Tamper-evident audit chain (application-level logging, not an external ledger):
 *   event_hash = SHA256(previous_event_hash + canonical_event_json)
 * Appends are serialized per organization by locking audit_chain_heads inside
 * the same transaction that inserts the event and advances the head.
 */

export function hashAuditEvent(previousHash: string | null, event: AuditEvent): string {
  return createHash("sha256")
    .update((previousHash ?? "") + canonicalAuditJson(event))
    .digest("hex");
}

export type AuditEventInput = Omit<AuditEvent, "id" | "occurred_at"> & {
  id?: string;
  occurred_at?: string;
};

/** Appends inside an existing tenant transaction (caller already set RLS). */
export async function appendAuditEventTx(
  tx: TransactionSql,
  input: AuditEventInput,
): Promise<AuditEvent> {
  const event = auditEventSchema.parse({
    ...input,
    id: input.id ?? uuidv7(),
    occurred_at: input.occurred_at ?? new Date().toISOString(),
  });

  // Serialize appends per organization: lock (or create) the chain head row.
  const heads = await tx<{ latest_event_hash: string | null }[]>`
    SELECT latest_event_hash FROM audit_chain_heads
    WHERE organization_id = ${event.organization_id}
    FOR UPDATE
  `;
  let previousHash: string | null;
  if (heads.length === 0) {
    await tx`
      INSERT INTO audit_chain_heads (organization_id, latest_event_id, latest_event_hash, updated_at)
      VALUES (${event.organization_id}, NULL, NULL, now())
    `;
    previousHash = null;
  } else {
    previousHash = heads[0]!.latest_event_hash;
  }

  const eventHash = hashAuditEvent(previousHash, event);

  await tx`
    INSERT INTO audit_events (
      id, organization_id, actor_type, actor_id, action, resource_type, resource_id,
      outcome, reason_code, metadata, request_id, occurred_at, previous_event_hash, event_hash
    ) VALUES (
      ${event.id}, ${event.organization_id}, ${event.actor_type}, ${event.actor_id},
      ${event.action}, ${event.resource_type}, ${event.resource_id ?? null},
      ${event.outcome}, ${event.reason_code ?? null}, ${JSON.stringify(event.metadata)}::jsonb,
      ${event.request_id ?? null}, ${event.occurred_at}, ${previousHash}, ${eventHash}
    )
  `;
  await tx`
    UPDATE audit_chain_heads
    SET latest_event_id = ${event.id}, latest_event_hash = ${eventHash}, updated_at = now()
    WHERE organization_id = ${event.organization_id}
  `;
  return event;
}

export async function appendAuditEvent(
  sql: Sql,
  ctx: TenantContext,
  input: AuditEventInput,
): Promise<AuditEvent> {
  return withTenant(sql, ctx, (tx) => appendAuditEventTx(tx, input));
}

export type ChainVerification =
  | { valid: true; event_count: number }
  | {
      valid: false;
      event_count: number;
      first_invalid_event_id: string | null;
      reason: "hash_mismatch" | "broken_link" | "head_mismatch" | "missing_head";
    };

/** Detects a missing, reordered, or mutated event anywhere in the org's chain. */
export async function verifyAuditChain(sql: Sql, ctx: TenantContext): Promise<ChainVerification> {
  return withTenant(sql, ctx, async (tx) => {
    const rows = await tx<
      Array<{
        id: string;
        organization_id: string;
        actor_type: AuditEvent["actor_type"];
        actor_id: string;
        action: string;
        resource_type: string;
        resource_id: string | null;
        outcome: AuditEvent["outcome"];
        reason_code: string | null;
        metadata: Record<string, string | number | boolean>;
        request_id: string | null;
        occurred_at: Date | string;
        previous_event_hash: string | null;
        event_hash: string;
      }>
    >`
      SELECT * FROM audit_events
      WHERE organization_id = ${ctx.organizationId}
      ORDER BY occurred_at ASC, id ASC
    `;

    let previousHash: string | null = null;
    for (const row of rows) {
      const event: AuditEvent = {
        id: row.id,
        organization_id: row.organization_id,
        actor_type: row.actor_type,
        actor_id: row.actor_id,
        action: row.action,
        resource_type: row.resource_type,
        outcome: row.outcome,
        metadata: row.metadata,
        occurred_at: new Date(row.occurred_at).toISOString(),
        ...(row.resource_id === null ? {} : { resource_id: row.resource_id }),
        ...(row.reason_code === null ? {} : { reason_code: row.reason_code }),
        ...(row.request_id === null ? {} : { request_id: row.request_id }),
      };
      if (row.previous_event_hash !== previousHash) {
        return {
          valid: false,
          event_count: rows.length,
          first_invalid_event_id: row.id,
          reason: "broken_link",
        } as const;
      }
      const expected = hashAuditEvent(previousHash, event);
      if (expected !== row.event_hash) {
        return {
          valid: false,
          event_count: rows.length,
          first_invalid_event_id: row.id,
          reason: "hash_mismatch",
        } as const;
      }
      previousHash = row.event_hash;
    }

    const heads = await tx<{ latest_event_hash: string | null }[]>`
      SELECT latest_event_hash FROM audit_chain_heads
      WHERE organization_id = ${ctx.organizationId}
    `;
    if (rows.length > 0) {
      if (heads.length === 0) {
        return {
          valid: false,
          event_count: rows.length,
          first_invalid_event_id: null,
          reason: "missing_head",
        } as const;
      }
      if (heads[0]!.latest_event_hash !== previousHash) {
        return {
          valid: false,
          event_count: rows.length,
          first_invalid_event_id: null,
          reason: "head_mismatch",
        } as const;
      }
    }
    return { valid: true, event_count: rows.length } as const;
  });
}
