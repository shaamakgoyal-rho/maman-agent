import {
  usableActions,
  visionObservationSchema,
  VISION_CONFIDENCE_FLOOR,
  type AppCategory,
  type VisionAction,
  type VisionObservation,
} from "@maman/contracts";

/**
 * Turning a vision model's answer into events the rest of the system already
 * understands.
 *
 * Two rules govern this file, and they pull in opposite directions on purpose.
 *
 * MODEL OUTPUT IS UNTRUSTED DATA. It is parsed with the strict schema, and
 * anything that does not fit is rejected whole rather than partially salvaged. A
 * response that is 90% valid is a response the model got wrong, and picking the
 * good parts out of it is how a hallucinated action gets in.
 *
 * IT FAILS SILENT. Below the confidence floor an action is DROPPED, not recorded
 * with a caveat. This is the same direction as date extraction and the opposite of
 * value matchers, because the consequences differ: a missed action means Maman
 * spots the pattern a run or two later, while a wrongly named one teaches the
 * pattern engine a workflow the user never performed — and that flows into
 * suggestions, an AgentSpec, and eventually a write.
 */

export type InterpretFailure =
  /** The response did not match the schema. Rejected whole. */
  | "invalid_output"
  /** Valid, but every action fell below the confidence floor. */
  | "below_confidence_floor"
  /** Valid, and the model said it could not tell. */
  | "model_uncertain"
  /** Valid and confident, but described nothing that happened. */
  | "no_actions";

export type InterpretResult =
  | { ok: true; observation: VisionObservation; actions: VisionAction[] }
  | { ok: false; reason: InterpretFailure; detail?: string };

/**
 * Parses one model response.
 *
 * `frameId`/`sessionId` are checked against the response rather than trusted from
 * it: a response that claims to describe a different frame is a correlation bug or
 * a mixed-up batch, and attributing it to this frame would silently record actions
 * from somewhere else in the session.
 */
export function interpretVisionResponse(
  raw: unknown,
  expect: { frameId: string; sessionId: string },
): InterpretResult {
  const parsed = visionObservationSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid_output",
      detail: parsed.error.issues[0]?.message ?? "did not match the schema",
    };
  }
  const observation = parsed.data;

  if (observation.frame_id !== expect.frameId || observation.session_id !== expect.sessionId) {
    return {
      ok: false,
      reason: "invalid_output",
      detail: "the response describes a different frame",
    };
  }

  if (observation.uncertain) return { ok: false, reason: "model_uncertain" };
  if (observation.actions.length === 0) return { ok: false, reason: "no_actions" };

  const actions = usableActions(observation);
  if (actions.length === 0) {
    return {
      ok: false,
      reason: "below_confidence_floor",
      detail: `nothing reached ${VISION_CONFIDENCE_FLOOR}`,
    };
  }

  return { ok: true, observation, actions };
}

/**
 * The canonical pattern token, built the same way every other source builds it:
 * `source:app_category:event_type:target_role:semantic_type:object_type`, with `-`
 * for anything absent.
 *
 * Reusing the existing vocabulary rather than inventing a vision-specific one is
 * what keeps the pattern engine, the domain packs, the ROI engine and both
 * drift-conformance fixtures working untouched — a vision-derived repetition and an
 * accessibility-derived repetition of the same workflow produce the SAME token, so
 * they count as the same pattern instead of two half-populated ones.
 */
export function canonicalTokenFor(action: VisionAction, appCategory: AppCategory): string {
  return [
    "teach_mode",
    appCategory,
    action.event_type,
    action.target_role === "unknown" ? "-" : action.target_role,
    action.semantic_type === "unknown" ? "-" : action.semantic_type,
    action.object_type ?? "-",
  ].join(":");
}

/** Every usable action from a response, as canonical tokens in order. */
export function canonicalTokens(
  actions: readonly VisionAction[],
  appCategory: AppCategory,
): string[] {
  return actions.map((a) => canonicalTokenFor(a, appCategory));
}

/**
 * A line for the user describing what Maman believes it saw.
 *
 * Teach Mode is the one observation path whose reading can be WRONG rather than
 * merely incomplete, so the user has to be able to check it. This is deliberately
 * plain and mentions the label but never a value.
 */
export function describeAction(action: VisionAction): string {
  const what = action.label === undefined ? action.target_role : `"${action.label}"`;
  const verb: Record<string, string> = {
    element_focused: "opened",
    element_activated: "clicked",
    value_committed: "filled in",
    record_opened: "opened the record for",
    record_updated: "changed",
    table_read: "read the list of",
    table_exported: "exported",
    navigation: "moved to",
    copy_semantic: "copied from",
    paste_semantic: "pasted into",
    app_activated: "switched to",
    window_focused: "focused",
    boundary_redacted: "reached a private area near",
    idle_started: "paused at",
    idle_ended: "returned to",
  };
  const action_verb = verb[action.event_type] ?? "acted on";
  const object = action.object_type === undefined ? "" : ` on a ${action.object_type}`;
  return `${action_verb} ${what}${object}`;
}
