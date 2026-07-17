import { z } from "zod";
import { utcTimestamp } from "./common.js";
import { workflowEventSchema } from "./workflow-event.js";

/**
 * Observer sidecar protocol: JSON Lines over stdin/stdout.
 * The sidecar has no network access; every line it emits is one of these
 * messages, schema-validated by the Rust core before any further processing.
 */

export const observerHelloSchema = z
  .object({
    type: z.literal("hello"),
    observer_version: z.string().min(1),
    capabilities: z.array(z.enum(["macos_ax", "teach_mode"])),
    pid: z.number().int().positive(),
  })
  .strict();

export const observerEventSchema = z
  .object({
    type: z.literal("event"),
    event: workflowEventSchema,
  })
  .strict();

/** Emitted when the observer enters a denied context — carries NO app identity. */
export const observerBoundarySchema = z
  .object({
    type: z.literal("boundary"),
    reason: z.enum(["hard_denied", "secure_field", "private_window", "user_private"]),
    occurred_at: utcTimestamp,
  })
  .strict();

export const observerHeartbeatSchema = z
  .object({
    type: z.literal("heartbeat"),
    occurred_at: utcTimestamp,
    events_emitted: z.number().int().nonnegative(),
  })
  .strict();

export const observerErrorSchema = z
  .object({
    type: z.literal("error"),
    code: z.string().min(1),
    message: z.string().min(1),
    fatal: z.boolean(),
  })
  .strict();

export const observerMessageSchema = z.discriminatedUnion("type", [
  observerHelloSchema,
  observerEventSchema,
  observerBoundarySchema,
  observerHeartbeatSchema,
  observerErrorSchema,
]);

export type ObserverMessage = z.infer<typeof observerMessageSchema>;

/** Core → observer control messages (stdin). */
export const observerControlSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("configure"),
      allowlist_bundles: z.array(z.string()),
      allowlist_domains: z.array(z.string()),
      private_apps: z.array(z.string()),
    })
    .strict(),
  z.object({ type: z.literal("pause") }).strict(),
  z.object({ type: z.literal("resume") }).strict(),
  z
    .object({
      type: z.literal("teach_mode_start"),
      max_seconds: z.number().int().min(1).max(900),
    })
    .strict(),
  z.object({ type: z.literal("teach_mode_stop") }).strict(),
  z.object({ type: z.literal("shutdown") }).strict(),
]);

export type ObserverControl = z.infer<typeof observerControlSchema>;
