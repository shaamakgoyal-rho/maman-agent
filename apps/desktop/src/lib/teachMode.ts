import {
  capturedFrameSchema,
  TEACH_MODE_MAX_SECONDS,
  uuidv7,
  type AppCategory,
  type CapturedFrame,
  type VisionAction,
} from "@maman/contracts";
import {
  canonicalTokenFor,
  describeAction,
  interpretVisionResponse,
  type InterpretFailure,
} from "@maman/teach-mode";
import { invokeCommand, isTauri } from "./bridge.js";

/**
 * Desktop side of Teach Mode: start/stop a session, and turn each vision answer
 * into something the rest of the system already understands.
 *
 * The pixels never reach here. By the time an observation arrives the Rust core
 * has already sent the frame, received the answer, and dropped the image — this
 * module only ever sees metadata and the model's JSON.
 */

/** What the panel shows about a session. Every field is a fact, not a guess. */
export type TeachSessionState =
  | { phase: "idle" }
  | { phase: "starting"; scope: string[] }
  | { phase: "recording"; sessionId: string; scope: string[]; startedAtMs: number }
  | { phase: "ended"; sessionId: string; reason: string }
  | { phase: "refused"; reason: string };

/** One reading Maman believes it saw, for the user to confirm or correct. */
export type TeachReading = {
  /** Stable across merges of the same observed action. See `mergeReading`. */
  id: string;
  frameId: string;
  /** Plain words, e.g. `filled in "Close date" on a opportunity`. */
  description: string;
  /** The canonical token this becomes if the user keeps it. */
  token: string;
  /** Highest confidence seen for this action across the frames that showed it. */
  confidence: number;
  /**
   * How many frames showed this same action. At a 2.5s cadence a single field
   * being filled appears in several consecutive frames, and three sightings of
   * one action are NOT three repetitions of the workflow.
   */
  seenCount: number;
  /** The user has not been asked yet, or has answered. */
  verdict: "unreviewed" | "kept" | "discarded";
  /** Kept so a kept reading can become a real event. Never rendered. */
  frame: CapturedFrame;
  action: VisionAction;
};

/**
 * Why a frame produced nothing. Surfaced verbatim, because "Maman is watching and
 * learning nothing" is a state the user is entitled to understand — and the
 * reasons are exactly the ones a privacy-conscious person would want to see.
 */
export type TeachSkip = { frameId: string; reason: InterpretFailure | string };

export function startTeachSession(
  scopeBundleIds: readonly string[],
  maxSeconds = 300,
): Promise<string> {
  if (!isTauri()) return Promise.reject(new Error("Teach Mode needs the desktop app"));
  // Clamp here as well as in Rust and in the observer's protocol. Three checks of
  // the same bound is not redundancy for its own sake: this one gives the user an
  // immediate answer instead of a refused control line they never see.
  const bounded = Math.max(1, Math.min(maxSeconds, TEACH_MODE_MAX_SECONDS));
  return invokeCommand<string>("teach_mode_start", {
    maxSeconds: bounded,
    scopeBundleIds: [...scopeBundleIds],
  });
}

export function stopTeachSession(): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  return invokeCommand<void>("teach_mode_stop");
}

/**
 * The payload the Rust core emits on `teach:observation`.
 *
 * `observation` is UNTRUSTED — it is the model's raw JSON. It is parsed against
 * the strict schema below and rejected whole if it does not fit.
 */
export type TeachObservationEvent = {
  frame?: unknown;
  observation?: unknown;
  /** Token counts the API reported for this frame, for real spend tracking. */
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_tokens?: number };
};

export type ReadingsResult =
  { ok: true; frame: CapturedFrame; readings: TeachReading[] } | { ok: false; skip: TeachSkip };

/**
 * Turns one vision answer into readings.
 *
 * The frame metadata is validated too, not just the model's reply: the metadata
 * comes from the observer over a pipe, and a `masked_regions` or `bundle_id` this
 * code cannot trust is not something to build a canonical event from.
 */
export function readingsFromObservation(
  payload: TeachObservationEvent,
  appCategoryFor: (bundleId: string) => AppCategory,
): ReadingsResult {
  const frameParsed = capturedFrameSchema.safeParse(payload.frame);
  if (!frameParsed.success) {
    return { ok: false, skip: { frameId: "unknown", reason: "invalid_frame_metadata" } };
  }
  const frame = frameParsed.data;

  const interpreted = interpretVisionResponse(payload.observation, {
    frameId: frame.frame_id,
    sessionId: frame.session_id,
  });
  if (!interpreted.ok) {
    return { ok: false, skip: { frameId: frame.frame_id, reason: interpreted.reason } };
  }

  const category = appCategoryFor(frame.bundle_id);
  return {
    ok: true,
    frame,
    readings: interpreted.actions.map((action) => ({
      // Identity is the ACTION, not the frame: the same action seen again in the
      // next frame must merge rather than appear twice.
      id: `${canonicalTokenFor(action, category)}|${action.label ?? ""}`,
      frameId: frame.frame_id,
      description: describeAction(action),
      token: canonicalTokenFor(action, category),
      confidence: action.confidence,
      seenCount: 1,
      verdict: "unreviewed" as const,
      frame,
      action,
    })),
  };
}

/**
 * Builds the WorkflowEvent for one KEPT reading.
 *
 * Two properties matter more than the shape:
 *
 * - `source: "teach_mode"` always, so a vision-derived reading is never
 *   indistinguishable from an observed one. It can be WRONG rather than merely
 *   incomplete, and anything downstream weighing evidence deserves to know.
 * - There is no field here for a pixel, a value, or a typed character. The event
 *   carries the same shape every other source produces, which is why the pattern
 *   engine, the packs and the ROI engine need no changes at all.
 */
export function eventFromReading(
  frame: CapturedFrame,
  action: VisionAction,
  identity: { deviceId: string; userId: string; organizationId: string },
): Record<string, unknown> {
  return {
    schema_version: 1,
    event_id: uuidv7(),
    device_id: identity.deviceId,
    user_id: identity.userId,
    organization_id: identity.organizationId,
    occurred_at: frame.captured_at,
    monotonic_ms: 0,
    source: "teach_mode",
    app: { bundle_id: frame.bundle_id, display_name: frame.bundle_id },
    event_type: action.event_type,
    // OMITTED, not null: `workflowEventSchema` marks these `.optional()` and is
    // `.strict()`, so an explicit null is rejected outright. "The model could not
    // tell what role this was" and "the role is the string null" are different
    // claims, and only one of them is true.
    target: {
      ...(action.target_role === "unknown" ? {} : { role: action.target_role }),
      ...(action.semantic_type === "unknown" ? {} : { semantic_type: action.semantic_type }),
    },
    context: action.object_type === undefined ? {} : { object_type: action.object_type },
    sensitivity: "internal",
    // Masking happened on device, before the frame left. Recorded so the audit
    // trail shows a redaction pass ran, and how much it covered.
    redaction: {
      applied: frame.masked_regions > 0,
      reasons: frame.masked_regions > 0 ? ["teach_mode_pre_egress_mask"] : [],
    },
  };
}

/**
 * Folds a new reading into the list, merging a repeat of the same action.
 *
 * Merging keeps the FIRST frame (the moment the action happened) and the HIGHEST
 * confidence, and counts sightings. A user's verdict survives a merge — having
 * discarded a misreading once, they should not be asked again two seconds later.
 */
export function mergeReading(
  existing: readonly TeachReading[],
  incoming: TeachReading,
): TeachReading[] {
  const at = existing.findIndex((r) => r.id === incoming.id);
  if (at === -1) return [...existing, incoming];
  const current = existing[at]!;
  const merged: TeachReading = {
    ...current,
    confidence: Math.max(current.confidence, incoming.confidence),
    seenCount: current.seenCount + 1,
  };
  return existing.map((r, i) => (i === at ? merged : r));
}

/** Listens for Teach Mode session status from the Rust core. */
export async function onTeachStatus(
  listener: (payload: { session_id?: string; state?: string; detail?: string | null }) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<{ session_id?: string; state?: string; detail?: string | null }>(
    "teach:status",
    (e) => listener(e.payload),
  );
}

/** Listens for one interpreted frame from the Rust core. */
export async function onTeachObservation(
  listener: (payload: TeachObservationEvent) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<TeachObservationEvent>("teach:observation", (e) => listener(e.payload));
}

/**
 * App category for a macOS bundle id, for the canonical token's second field.
 *
 * Deliberately coarse and deliberately defaulting to `browser` for unknown
 * BROWSERS and `other` for everything else. A wrong category makes a token that
 * does not group with its siblings — annoying, and visible in the readings the
 * user reviews — whereas guessing "crm" for an unknown app would quietly file a
 * demonstration under a domain it does not belong to.
 *
 * Native apps cannot be classified more finely than this from a bundle id alone:
 * a browser showing Salesforce is `browser` here, and the Chrome relay is what
 * supplies domain-level detail for the same work.
 */
const BUNDLE_CATEGORY: Record<string, AppCategory> = {
  "com.google.Chrome": "browser",
  "com.apple.Safari": "browser",
  "company.thebrowser.Browser": "browser",
  "com.microsoft.edgemac": "browser",
  "org.mozilla.firefox": "browser",
  "com.microsoft.Outlook": "email",
  "com.apple.mail": "email",
  "com.apple.iCal": "calendar",
  "com.microsoft.Excel": "spreadsheet",
  "com.apple.Numbers": "spreadsheet",
  "com.tinyspeck.slackmacgap": "other",
  "notion.id": "research",
};

export function appCategoryForBundle(bundleId: string): AppCategory {
  return BUNDLE_CATEGORY[bundleId] ?? "other";
}

/** Seconds left in a session, for the countdown the user sees. */
export function secondsRemaining(
  state: TeachSessionState,
  maxSeconds: number,
  nowMs: number,
): number {
  if (state.phase !== "recording") return 0;
  const elapsed = Math.floor((nowMs - state.startedAtMs) / 1000);
  return Math.max(0, maxSeconds - elapsed);
}
