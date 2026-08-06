import { z } from "zod";
import { appCategory, looksLikeSecret, utcTimestamp, uuid } from "./common.js";
import { workflowEventType } from "./workflow-event.js";

/**
 * Teach Mode: deriving observed actions from screen frames instead of from
 * deterministic accessibility events.
 *
 * WHY THIS FILE IS SHAPED THE WAY IT IS
 *
 * Screen capture is the one place this product deliberately left a hole and did
 * not fill it: the observer emitted `teach_mode_unavailable`, and Privacy has
 * always said "Screen Recording — Teach Mode only, never granted in advance".
 * This is that slot, now occupied.
 *
 * Frames are sent to a vision model, which means PIXELS LEAVE THE DEVICE. That is
 * an explicit, documented decision by the product owner and it changes what the
 * product may honestly claim; CLAUDE.md and the Privacy screen were amended in the
 * same change rather than left describing the old behaviour.
 *
 * What that decision did NOT change, and this file enforces:
 *
 * 1. NO KEYSTROKES, EVER. There is no field here that could carry typed input.
 *    A vision model can see that a field was filled; it is never told what keys
 *    were pressed, because nothing captures them.
 * 2. SECRET MATERIAL NEVER ENTERS PROMPTS. A frame is now prompt content, so the
 *    on-device redaction pass that runs before egress is load-bearing for that
 *    rule — see `@maman/teach-mode`'s `frameEgressDecision`.
 * 3. THE MODEL MAY NEVER CHANGE ELIGIBILITY, RISK, PERMISSIONS OR VALUE. Not
 *    "is policy-checked afterwards" — there is no field in `visionActionSchema`
 *    that could express any of them. The model names WHAT it saw; whether that is
 *    automatable, how risky it is, and what it is worth stay deterministic.
 * 4. PIXELS ARE NEVER PERSISTED. `containsForbiddenEventField` already rejects any
 *    payload with a `screenshot` field. Frames are interpreted and discarded; only
 *    the derived canonical event is stored.
 */

/**
 * Upper bound on one capture session, matching the observer's existing control
 * protocol (`teach_mode_start` rejects anything over 900). Teach Mode is a thing
 * the user starts and that stops itself; it is not a mode you can leave on.
 */
export const TEACH_MODE_MAX_SECONDS = 900;

/**
 * Below this, an action is DROPPED rather than recorded.
 *
 * Fail-SILENT, the same direction as date extraction and the opposite of value
 * matchers. The asymmetry is deliberate: a missed action means Maman notices a
 * repeated workflow later, while a WRONGLY NAMED action teaches the pattern engine
 * a workflow the user never performed — and that propagates into suggestions,
 * AgentSpecs and eventually a write.
 */
export const VISION_CONFIDENCE_FLOOR = 0.75;

export const teachModeSessionSchema = z
  .object({
    schema_version: z.literal(1),
    session_id: uuid,
    /** The user started this deliberately. There is no implicit session. */
    started_at: utcTimestamp,
    /** Self-terminating; see TEACH_MODE_MAX_SECONDS. */
    max_seconds: z.number().int().min(1).max(TEACH_MODE_MAX_SECONDS),
    /**
     * Bundle ids the user chose to demonstrate in. A frame from any other app is
     * refused before egress — starting a session is not consent to capture
     * everything that happens to be on screen.
     */
    scope_bundle_ids: z.array(z.string().min(1)).min(1).max(16),
  })
  .strict();
export type TeachModeSession = z.infer<typeof teachModeSessionSchema>;

/**
 * What is known about one captured frame. Note what is absent: the frame itself.
 *
 * Pixels travel as an opaque binary alongside this metadata and are never a field
 * on a schema, so they cannot be persisted, logged or synced by accident.
 */
export const capturedFrameSchema = z
  .object({
    schema_version: z.literal(1),
    frame_id: uuid,
    session_id: uuid,
    captured_at: utcTimestamp,
    /** Foreground app at capture time; drives the egress decision. */
    bundle_id: z.string().min(1),
    app_category: appCategory,
    /** Frame geometry only — no window title, no content. */
    width: z.number().int().positive().max(20000),
    height: z.number().int().positive().max(20000),
    /** How many regions the on-device pass masked before this frame could leave. */
    masked_regions: z.number().int().nonnegative().max(1000),
  })
  .strict();
export type CapturedFrame = z.infer<typeof capturedFrameSchema>;

/** A rectangle to paint over before a frame is allowed to leave the device. */
export const maskRegionSchema = z
  .object({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    /** Why, for the audit trail the user can inspect. Never the masked content. */
    reason: z.enum([
      "secure_field",
      "secret_shaped_text",
      "password_manager_ui",
      "unrecognised_credential_field",
    ]),
  })
  .strict();
export type MaskRegion = z.infer<typeof maskRegionSchema>;

/**
 * A bounded, non-secret label the model may report.
 *
 * `looksLikeSecret` is applied to MODEL OUTPUT as well as to input: a frame whose
 * redaction pass missed something must not get a second chance to launder it back
 * through the model's description of what it saw.
 */
const observedLabel = z
  .string()
  .min(1)
  .max(80)
  .refine((v) => !looksLikeSecret(v), { message: "value matches a secret shape" });

/**
 * ONE action the vision model claims to have observed.
 *
 * The field list is the security boundary. There is deliberately no `risk`, no
 * `eligible`, no `automatable`, no `capability`, no `permission`, no
 * `minutes_saved` and no `value` — a hallucinated or adversarial response cannot
 * assert any of them because the schema has nowhere to put them. `.strict()`
 * rejects them outright rather than ignoring them.
 *
 * `event_type` reuses the EXISTING canonical vocabulary rather than inventing a
 * vision-specific one, so everything downstream — pattern engine, domain packs,
 * ROI, both drift-conformance fixtures — keeps working untouched.
 */
export const visionActionSchema = z
  .object({
    event_type: workflowEventType,
    /**
     * Role of the thing acted on, e.g. "field", "button", "row". Constrained
     * vocabulary so it can form a canonical token.
     */
    target_role: z.enum([
      "field",
      "button",
      "row",
      "cell",
      "menu",
      "tab",
      "link",
      "list",
      "document",
      "unknown",
    ]),
    /** What KIND of thing, e.g. "date", "amount", "name". Never its value. */
    semantic_type: z.enum([
      "date",
      "amount",
      "percent",
      "name",
      "identifier",
      "status",
      "email",
      "url",
      "text",
      "unknown",
    ]),
    /** The business object, e.g. "invoice", "account". Lowercase snake. */
    object_type: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,31}$/)
      .optional(),
    /**
     * The visible label of the control, for the user to check the reading against.
     * NOT the value in it — a vision model can see "Close date" and that it was
     * edited without reporting what it now says.
     */
    label: observedLabel.optional(),
    /** 0..1. Anything under VISION_CONFIDENCE_FLOOR is dropped by the caller. */
    confidence: z.number().min(0).max(1),
  })
  .strict();
export type VisionAction = z.infer<typeof visionActionSchema>;

/**
 * What one frame (or frame pair) yielded.
 *
 * `uncertain` exists so the model has a way to say "I could not tell", which is a
 * better answer than a low-confidence guess and is recorded as such rather than
 * silently producing nothing.
 */
export const visionObservationSchema = z
  .object({
    schema_version: z.literal(1),
    frame_id: uuid,
    session_id: uuid,
    /** Empty is a valid, common answer: most frames show no discrete action. */
    actions: z.array(visionActionSchema).max(8),
    uncertain: z.boolean(),
    /** Free text for the user, never parsed for control flow. */
    note: z.string().max(200).optional(),
  })
  .strict();
export type VisionObservation = z.infer<typeof visionObservationSchema>;

/** Actions at or above the confidence floor. The only gate callers should use. */
export function usableActions(observation: VisionObservation): VisionAction[] {
  return observation.actions.filter((a) => a.confidence >= VISION_CONFIDENCE_FLOOR);
}
