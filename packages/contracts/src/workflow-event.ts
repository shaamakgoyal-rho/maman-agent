import { z } from "zod";
import { eventSource, schemaVersion1, sensitivity, utcTimestamp, uuid } from "./common.js";

/**
 * WorkflowEvent — the only shape observation data may take.
 *
 * Never includes raw field values, email bodies, typed text, access tokens,
 * cookies, passwords, or full record identifiers. Enforced structurally: the
 * schema is strict and only carries roles, hashes, categories, and counts.
 */

export const workflowEventType = z.enum([
  "app_activated",
  "window_focused",
  "element_focused",
  "element_activated",
  "value_committed",
  "navigation",
  "record_opened",
  "record_updated",
  "table_read",
  "table_exported",
  "copy_semantic",
  "paste_semantic",
  "boundary_redacted",
  "idle_started",
  "idle_ended",
]);
export type WorkflowEventType = z.infer<typeof workflowEventType>;

export const workflowEventSchema = z
  .object({
    schema_version: schemaVersion1,
    event_id: uuid,
    device_id: uuid,
    user_id: uuid,
    organization_id: uuid,
    occurred_at: utcTimestamp,
    monotonic_ms: z.number().int().nonnegative(),
    source: eventSource,
    app: z
      .object({
        bundle_id: z.string().optional(),
        domain: z.string().optional(),
        display_name: z.string(),
      })
      .strict(),
    event_type: workflowEventType,
    target: z
      .object({
        role: z.string().optional(),
        semantic_type: z.string().optional(),
        stable_id_hash: z.string().optional(),
        label_hash: z.string().optional(),
      })
      .strict(),
    context: z
      .object({
        page_type: z.string().optional(),
        object_type: z.string().optional(),
        record_id_hash: z.string().optional(),
        field_names: z.array(z.string()).optional(),
        item_count: z.number().int().nonnegative().optional(),
      })
      .strict(),
    duration_ms: z.number().int().nonnegative().optional(),
    sensitivity,
    redaction: z
      .object({
        applied: z.boolean(),
        reasons: z.array(z.string()),
      })
      .strict(),
  })
  .strict();

export type WorkflowEvent = z.infer<typeof workflowEventSchema>;

/**
 * Field names that must never appear anywhere inside a WorkflowEvent payload.
 * Used by redaction tests and the local normalizer as a defense-in-depth check.
 */
export const FORBIDDEN_EVENT_FIELDS = [
  "value",
  "text",
  "password",
  "token",
  "cookie",
  "secret",
  "body",
  "clipboard",
  "keystrokes",
  "key_code",
  "screenshot",
] as const;

/** Deep-scan an unknown payload for forbidden field names before persistence. */
export function containsForbiddenEventField(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null;
  for (const [key, val] of Object.entries(payload as Record<string, unknown>)) {
    if ((FORBIDDEN_EVENT_FIELDS as readonly string[]).includes(key.toLowerCase())) {
      return key;
    }
    const nested = containsForbiddenEventField(val);
    if (nested) return nested;
  }
  return null;
}
