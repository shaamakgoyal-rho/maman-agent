import { z } from "zod";
import { eventSource, schemaVersion1, sensitivity, utcTimestamp, uuid } from "./common.js";

/**
 * WorkflowEvent — the only shape observation data may take.
 *
 * Never includes raw field values, email bodies, typed text, access tokens,
 * cookies, passwords, or full record identifiers. Enforced structurally: the
 * schema is strict and only carries roles, hashes, categories, and counts.
 */

/** Pack-taxonomy ids: lower_snake_case, matching the domain-pack identifier rule. */
export const packIdentifier = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/);

/**
 * Domain classification produced on-device by the pack classifier (L1).
 *
 * `confidence` is the classifier's own certainty, NOT a value extraction. Policy
 * must treat low confidence as fail-closed (threshold exceeded), never as
 * permission — see the amount/percent extractors.
 */
export const domainClassification = z
  .object({
    domain: packIdentifier,
    object: packIdentifier.optional(),
    action: packIdentifier.optional(),
    confidence: z.number().min(0).max(1),
  })
  .strict();
export type DomainClassification = z.infer<typeof domainClassification>;

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
        /**
         * Pack label-pattern strings that matched the (pre-hash) label inside
         * the observer — pack constants from committed YAML, never label text.
         * Same privacy class as object_type: reveals pack membership only.
         * Bounded: the observer caps at 8 hits.
         */
        label_pattern_hits: z.array(z.string().min(1).max(64)).max(8).optional(),
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
    /**
     * Domain-pack classification (L1). Typed abstractions in the same privacy
     * class as `object_type` — ids drawn from a pack's declared taxonomy, never
     * free text derived from content. Absent when nothing matched: an
     * unclassified event stays unclassified rather than being forced into a
     * domain.
     */
    classification: domainClassification.optional(),
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
