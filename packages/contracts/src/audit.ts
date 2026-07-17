import { z } from "zod";
import { utcTimestamp, uuid } from "./common.js";

export const auditActorType = z.enum(["user", "device", "service", "system"]);
export type AuditActorType = z.infer<typeof auditActorType>;

export const auditOutcome = z.enum(["success", "denied", "failure"]);
export type AuditOutcome = z.infer<typeof auditOutcome>;

/**
 * Audit event as written to the hash chain. metadata is schema-validated JSON
 * that must never contain workflow content, tokens, or secrets.
 */
export const auditEventSchema = z
  .object({
    id: uuid,
    organization_id: uuid,
    actor_type: auditActorType,
    actor_id: z.string().min(1),
    action: z.string().min(1),
    resource_type: z.string().min(1),
    resource_id: z.string().optional(),
    outcome: auditOutcome,
    reason_code: z.string().optional(),
    metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    request_id: z.string().optional(),
    occurred_at: utcTimestamp,
  })
  .strict();

export type AuditEvent = z.infer<typeof auditEventSchema>;

/**
 * Canonical JSON for hashing: stable key order, no whitespace variance.
 * event_hash = SHA256(previous_event_hash + canonical_event_json)
 */
export function canonicalAuditJson(event: AuditEvent): string {
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(event).sort()) {
    const value = (event as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (key === "metadata" && value && typeof value === "object") {
      const meta: Record<string, unknown> = {};
      for (const mk of Object.keys(value as Record<string, unknown>).sort()) {
        meta[mk] = (value as Record<string, unknown>)[mk];
      }
      ordered[key] = meta;
    } else {
      ordered[key] = value;
    }
  }
  return JSON.stringify(ordered);
}
