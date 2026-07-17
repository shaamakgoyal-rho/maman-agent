import type { AgentState } from "@maman/contracts";

/**
 * Agent lifecycle (spec §13). Allowed transitions are locked; everything else
 * is rejected. Promotions carry actor requirements checked by the caller.
 */

const TRANSITIONS: Record<AgentState, AgentState[]> = {
  draft: ["shadow", "degraded", "revoked", "archived"],
  shadow: ["draft", "supervised", "degraded", "revoked", "archived"],
  supervised: ["shadow", "active", "degraded", "revoked", "archived"],
  active: ["paused", "degraded", "revoked", "archived"],
  paused: ["active", "degraded", "revoked", "archived"],
  degraded: ["shadow", "revoked", "archived"],
  revoked: [],
  archived: [],
};

export function canTransition(from: AgentState, to: AgentState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export type TransitionRequest = {
  from: AgentState;
  to: AgentState;
  actor: "user" | "system" | "policy";
  /** Set when org policy allows supervised → active. */
  org_policy_allows_activation?: boolean;
};

export type TransitionResult = { allowed: true } | { allowed: false; reason: string };

export function evaluateTransition(request: TransitionRequest): TransitionResult {
  if (!canTransition(request.from, request.to)) {
    return { allowed: false, reason: `transition ${request.from} → ${request.to} is not allowed` };
  }
  // Only a user may promote shadow → supervised.
  if (request.from === "shadow" && request.to === "supervised" && request.actor !== "user") {
    return { allowed: false, reason: "only a user may promote shadow to supervised" };
  }
  // Only a user AND organization policy together promote supervised → active.
  if (request.from === "supervised" && request.to === "active") {
    if (request.actor !== "user") {
      return { allowed: false, reason: "only a user may promote supervised to active" };
    }
    if (!request.org_policy_allows_activation) {
      return { allowed: false, reason: "organization policy does not allow activation" };
    }
  }
  // Archived and revoked agents cannot run — transitions out are impossible.
  return { allowed: true };
}

/** Any material spec edit returns the agent to shadow with a new version. */
export function stateAfterMaterialEdit(_current: AgentState): AgentState {
  return "shadow";
}
