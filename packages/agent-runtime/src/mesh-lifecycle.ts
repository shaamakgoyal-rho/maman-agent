import type { AgentState } from "@maman/contracts";

/**
 * Capability Mesh lifecycle — the discovery-to-autonomy journey:
 *   observed → candidate_detected → connector_suggested → shadowing →
 *   draft_agent → supervised → approved → autonomous → paused → retired
 *
 * Autonomy is NEVER granted because a confidence score is high: every
 * promotion past `shadowing` requires the applicable human approval, and
 * `autonomous` additionally requires org policy.
 */

export type MeshState =
  | "observed"
  | "candidate_detected"
  | "connector_suggested"
  | "shadowing"
  | "draft_agent"
  | "supervised"
  | "approved"
  | "autonomous"
  | "paused"
  | "retired";

const MESH_TRANSITIONS: Record<MeshState, MeshState[]> = {
  observed: ["candidate_detected", "retired"],
  candidate_detected: ["connector_suggested", "shadowing", "draft_agent", "retired"],
  connector_suggested: ["shadowing", "candidate_detected", "retired"],
  shadowing: ["draft_agent", "candidate_detected", "retired"],
  draft_agent: ["supervised", "shadowing", "retired"],
  supervised: ["approved", "shadowing", "paused", "retired"],
  approved: ["autonomous", "supervised", "paused", "retired"],
  autonomous: ["paused", "supervised", "retired"],
  paused: ["supervised", "approved", "autonomous", "retired"],
  retired: [],
};

/** Promotions requiring a human decision (never automatic). */
const HUMAN_GATED: Array<[MeshState, MeshState]> = [
  ["shadowing", "draft_agent"],
  ["draft_agent", "supervised"],
  ["supervised", "approved"],
  ["approved", "autonomous"],
  ["paused", "autonomous"],
  ["paused", "approved"],
];

export type MeshTransitionRequest = {
  from: MeshState;
  to: MeshState;
  actor: "user" | "admin" | "system";
  /** Shadow agreement stats — informative only; can never substitute approval. */
  shadow_agreement?: { successful_comparisons: number; required_comparisons: number };
  org_policy_allows_autonomy?: boolean;
};

export type MeshTransitionResult = { allowed: true } | { allowed: false; reason: string };

export function evaluateMeshTransition(req: MeshTransitionRequest): MeshTransitionResult {
  if (!MESH_TRANSITIONS[req.from]?.includes(req.to)) {
    return { allowed: false, reason: `transition ${req.from} → ${req.to} is not allowed` };
  }
  const humanGated = HUMAN_GATED.some(([f, t]) => f === req.from && t === req.to);
  if (humanGated && req.actor === "system") {
    return {
      allowed: false,
      reason: "promotion requires a human decision — confidence alone never promotes",
    };
  }
  if (req.from === "shadowing" && req.to === "draft_agent") {
    const agreement = req.shadow_agreement;
    if (!agreement || agreement.successful_comparisons < agreement.required_comparisons) {
      return {
        allowed: false,
        reason: `needs ${req.shadow_agreement?.required_comparisons ?? "configured"} successful shadow comparisons before promotion is recommended`,
      };
    }
  }
  if (req.to === "autonomous") {
    if (req.actor !== "admin" && req.actor !== "user") {
      return { allowed: false, reason: "autonomy requires user or admin approval" };
    }
    if (!req.org_policy_allows_autonomy) {
      return { allowed: false, reason: "organization policy does not allow autonomy" };
    }
  }
  return { allowed: true };
}

/** Mesh state → core agent state used by the run engine and persistence. */
export function meshToAgentState(mesh: MeshState): AgentState {
  switch (mesh) {
    case "observed":
    case "candidate_detected":
    case "connector_suggested":
      return "draft";
    case "shadowing":
      return "shadow";
    case "draft_agent":
      return "draft";
    case "supervised":
      return "supervised";
    case "approved":
    case "autonomous":
      return "active";
    case "paused":
      return "paused";
    case "retired":
      return "archived";
  }
}
