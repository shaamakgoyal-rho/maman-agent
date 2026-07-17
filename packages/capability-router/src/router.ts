import {
  DEFAULT_ROUTING_POLICY,
  type CapabilityAvailability,
  type CapabilitySource,
  type ExecutionRoute,
  type RoutingPolicy,
  type StepOutcome,
} from "./types.js";

/**
 * Deterministic capability routing (Desktop Capability Mesh).
 *
 * Locked behavior:
 *  1. Remove capabilities without required permissions or scopes.
 *  2. Remove capabilities blocked by company or user policy.
 *  3. Prefer APIs when they produce an equivalent outcome.
 *  4. Prefer independently verifiable and idempotent operations.
 *  5. Browser Relay: current-page context, UI-only actions, supervised forms.
 *  6. macOS Accessibility: discovery and app boundaries — never writes.
 *  7. Teach Mode only after explicit activation.
 *  8. Ask the user when no safe route exists.
 *  9. NEVER convert an API failure into an unapproved browser write.
 * 10. Verify consequential writes with an independent read where possible.
 */

export type RoutingResult =
  { routed: true; route: ExecutionRoute } | { routed: false; reason: string; askUser: true };

/** Deterministic route score: bigger is better. */
export function scoreRoute(availability: CapabilityAvailability, outcome: StepOutcome): number {
  const safety = { low: 1, medium: 0.7, high: 0.35, critical: 0.1 }[availability.riskLevel];
  const auditability =
    availability.source === "api" ? 1 : availability.source === "browser_extension" ? 0.6 : 0.4;
  const semanticFidelity =
    availability.source === "api"
      ? 1
      : availability.source === "browser_extension"
        ? 0.75
        : availability.source === "macos_accessibility"
          ? 0.5
          : 0.4;
  const latency = 1 - Math.min(1, availability.estimatedLatencyMs / 30_000);
  const cost = 1 - Math.min(1, availability.estimatedCostUsd / 1);
  const interruption = availability.requiresForeground || availability.requiresApproval ? 0 : 1;
  const degradedPenalty = availability.status === "degraded" ? 0.15 : 0;

  return (
    0.25 * availability.reliabilityScore +
    0.2 * safety +
    0.15 * auditability +
    0.15 * semanticFidelity +
    0.1 * latency +
    0.1 * cost +
    0.05 * interruption -
    degradedPenalty +
    // API preference: a decisive, explicit bonus when the outcome is equivalent.
    (availability.source === "api" && !outcome.teachModeActive ? 0.15 : 0)
  );
}

function eligible(
  availability: CapabilityAvailability,
  outcome: StepOutcome,
  policy: RoutingPolicy,
): { ok: boolean; why?: string } {
  // 1. permissions and scopes
  if (availability.status === "unavailable") return { ok: false, why: "unavailable" };
  if (availability.status === "permission_required") {
    return { ok: false, why: "permission_required" };
  }
  const missingScopes = outcome.requiredScopes.filter((s) => !availability.scopes.includes(s));
  if (availability.source === "api" && missingScopes.length > 0) {
    return { ok: false, why: `missing scopes: ${missingScopes.join(", ")}` };
  }
  // 2. policy blocks
  if (policy.blockedSources.includes(availability.source))
    return { ok: false, why: "source blocked" };
  if (policy.blockedCapabilities.includes(availability.capabilityId)) {
    return { ok: false, why: "capability blocked" };
  }
  if (availability.estimatedCostUsd > policy.maxStepCostUsd) {
    return { ok: false, why: "over step cost ceiling" };
  }
  // 6. Accessibility is discovery-only: never a consequential write source.
  if (availability.source === "macos_accessibility" && outcome.consequential) {
    return { ok: false, why: "accessibility source never performs writes" };
  }
  // 7. Teach mode requires explicit activation this session.
  if (availability.source === "teach_mode" && !outcome.teachModeActive) {
    return { ok: false, why: "teach mode not active" };
  }
  // 5. Browser writes are supervised-only: user present + approval + policy.
  if (availability.source === "browser_extension" && outcome.consequential) {
    if (!policy.allowSupervisedBrowserWrites) return { ok: false, why: "browser writes disabled" };
    if (!outcome.userPresent) return { ok: false, why: "browser writes require a present user" };
    if (!availability.requiresApproval) {
      return { ok: false, why: "browser writes must be approval-gated" };
    }
  }
  // critical risk is never routable automatically
  if (availability.riskLevel === "critical") return { ok: false, why: "critical risk" };
  return { ok: true };
}

export function routeStep(
  outcome: StepOutcome,
  availabilities: CapabilityAvailability[],
  policy: RoutingPolicy = DEFAULT_ROUTING_POLICY,
): RoutingResult {
  const candidates = availabilities
    .filter((a) => a.capabilityId === outcome.capabilityId)
    .map((a) => ({ availability: a, check: eligible(a, outcome, policy) }))
    .filter((c) => c.check.ok)
    .map((c) => ({
      availability: c.availability,
      score: scoreRoute(c.availability, outcome),
    }))
    .sort(
      (x, y) =>
        y.score - x.score ||
        // deterministic tiebreak: source enum order
        x.availability.source.localeCompare(y.availability.source),
    );

  if (candidates.length === 0) {
    // 8. Ask the user when no safe route exists.
    return {
      routed: false,
      askUser: true,
      reason: "no safe execution route is currently available for this step",
    };
  }

  const selected = candidates[0]!;
  // 9. Fallbacks: for consequential steps, NEVER allow an automatic fallback
  // from a failed API write into a browser write. Consequential steps stop
  // and ask; only non-consequential reads may try the next source.
  const fallbackSources: CapabilitySource[] = outcome.consequential
    ? []
    : candidates.slice(1).map((c) => c.availability.source);

  return {
    routed: true,
    route: {
      stepId: outcome.stepId,
      selectedSource: selected.availability.source,
      fallbackSources,
      reason: buildReason(selected.availability, outcome),
      estimatedCostUsd: selected.availability.estimatedCostUsd,
      confidence: Math.round(Math.min(1, selected.score) * 100) / 100,
      // 10. Independent verification for consequential writes when an API
      // read exists for the capability; the worker enforces it at run time.
      verification: outcome.consequential ? "independent_read" : "none",
      onFailure: outcome.consequential ? "stop_and_ask_user" : "try_next_fallback",
    },
  };
}

function buildReason(availability: CapabilityAvailability, outcome: StepOutcome): string {
  const parts = [`${availability.source} selected`];
  if (availability.source === "api") parts.push("API produces an equivalent, auditable outcome");
  if (availability.source === "browser_extension") {
    parts.push(
      outcome.consequential
        ? "supervised browser action with user present and approval gate"
        : "current-page context via the Browser Relay",
    );
  }
  if (availability.source === "macos_accessibility") parts.push("discovery-only desktop context");
  if (availability.source === "teach_mode") parts.push("explicit teach-mode session");
  if (availability.source === "human")
    parts.push("no automated route is safe; human performs the step");
  if (availability.status === "degraded") parts.push("source is degraded — fidelity reduced");
  return parts.join("; ");
}
