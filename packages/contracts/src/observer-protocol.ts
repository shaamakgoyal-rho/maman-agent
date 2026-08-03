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

/**
 * Geometry of the window currently being monitored, so the subtitle bar can dock
 * to it (logical points, top-left origin — AX's convention, which is also
 * Tauri's, so nothing converts in between).
 *
 * TRANSIENT UI STATE. The core repositions a window and drops it: this is never
 * written to the store, never projected into features, and never synced. It
 * carries no app identity and no content — a rectangle only — and the observer
 * emits it solely for contexts it is genuinely observing, so a hard-denied or
 * private window's geometry never leaves the observer at all.
 *
 * `frame: null` is a real state, not an absence: nothing is being monitored, so
 * the bar must detach rather than stay stuck to a stale rectangle.
 */
export const observerWindowFrameSchema = z
  .object({
    type: z.literal("window_frame"),
    occurred_at: utcTimestamp,
    frame: z
      .object({
        x: z.number(),
        y: z.number(),
        width: z.number().positive(),
        height: z.number().positive(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const observerMessageSchema = z.discriminatedUnion("type", [
  observerHelloSchema,
  observerEventSchema,
  observerBoundarySchema,
  observerHeartbeatSchema,
  observerErrorSchema,
  observerWindowFrameSchema,
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
