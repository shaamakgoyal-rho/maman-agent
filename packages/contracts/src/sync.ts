import { z } from "zod";
import { eventSource, schemaVersion1, sensitivity, utcTimestamp, uuid } from "./common.js";

/**
 * The ONLY workflow-event shape allowed to leave a device. It is a redacted,
 * identity-safe projection: coarse category + semantic tags + bucketed counts,
 * never an app display name, domain, URL, raw payload, keystroke, or field
 * value. The schema is `.strict()`, so any raw-event field (e.g. `app`,
 * `payload`, `value`, `text`, `domain`) fails to parse and cannot be uploaded.
 *
 * All fields here are scalars/enums — there is deliberately no free-form object
 * field where raw content could hide.
 */
export const syncEventProjectionSchema = z
  .object({
    schema_version: schemaVersion1,
    event_id: uuid,
    occurred_at: utcTimestamp,
    monotonic_ms: z.number().int().nonnegative(),
    source: eventSource,
    app_category: z.string().min(1).max(64),
    event_type: z.string().min(1).max(64),
    sensitivity,
    excluded_from_learning: z.boolean(),
    target_role: z.string().min(1).max(64).optional(),
    semantic_type: z.string().min(1).max(64).optional(),
    object_type: z.string().min(1).max(64).optional(),
    duration_ms: z.number().int().nonnegative().optional(),
    item_count_bucket: z.enum(["1", "2_10", "11_50", "51_200", "201_plus"]).optional(),
  })
  .strict();
export type SyncEventProjection = z.infer<typeof syncEventProjectionSchema>;

export const SYNC_MAX_BATCH_SIZE = 200;

export const syncBatchRequestSchema = z
  .object({
    schema_version: schemaVersion1,
    events: z.array(syncEventProjectionSchema).min(1).max(SYNC_MAX_BATCH_SIZE),
  })
  .strict();
export type SyncBatchRequest = z.infer<typeof syncBatchRequestSchema>;

export const syncBatchResponseSchema = z
  .object({
    accepted: z.number().int().nonnegative(),
    deduped: z.number().int().nonnegative(),
    server_time: utcTimestamp,
  })
  .strict();
export type SyncBatchResponse = z.infer<typeof syncBatchResponseSchema>;
