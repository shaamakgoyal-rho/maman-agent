import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROUTING_POLICY,
  routeStep,
  scoreRoute,
  type CapabilityAvailability,
  type StepOutcome,
} from "../src/index.js";

const CAP = "salesforce.update_fields";

function avail(overrides: Partial<CapabilityAvailability> = {}): CapabilityAvailability {
  return {
    capabilityId: CAP,
    source: "api",
    status: "available",
    scopes: ["api"],
    riskLevel: "medium",
    reliabilityScore: 0.95,
    estimatedLatencyMs: 800,
    estimatedCostUsd: 0.01,
    requiresForeground: false,
    requiresApproval: true,
    ...overrides,
  };
}

function outcome(overrides: Partial<StepOutcome> = {}): StepOutcome {
  return {
    stepId: "s1",
    capabilityId: CAP,
    consequential: true,
    requiredScopes: ["api"],
    teachModeActive: false,
    userPresent: true,
    ...overrides,
  };
}

const browserWrite = () =>
  avail({
    source: "browser_extension",
    scopes: [],
    riskLevel: "high",
    reliabilityScore: 0.7,
    estimatedLatencyMs: 5_000,
    requiresForeground: true,
    requiresApproval: true,
  });

describe("filtering (rules 1–2)", () => {
  it("removes sources without required API scopes", () => {
    const result = routeStep(outcome(), [avail({ scopes: [] })]);
    expect(result.routed).toBe(false);
  });

  it("removes permission_required and unavailable sources", () => {
    for (const status of ["permission_required", "unavailable"] as const) {
      expect(routeStep(outcome(), [avail({ status })]).routed).toBe(false);
    }
  });

  it("removes policy-blocked sources and capabilities", () => {
    expect(
      routeStep(outcome(), [avail()], { ...DEFAULT_ROUTING_POLICY, blockedSources: ["api"] })
        .routed,
    ).toBe(false);
    expect(
      routeStep(outcome(), [avail()], {
        ...DEFAULT_ROUTING_POLICY,
        blockedCapabilities: [CAP],
      }).routed,
    ).toBe(false);
  });

  it("removes routes above the step cost ceiling", () => {
    expect(
      routeStep(outcome(), [avail({ estimatedCostUsd: 2 })], {
        ...DEFAULT_ROUTING_POLICY,
        maxStepCostUsd: 1,
      }).routed,
    ).toBe(false);
  });
});

describe("API preference (rule 3) — the router demonstrably prefers APIs", () => {
  it("selects API over an eligible supervised browser route", () => {
    const result = routeStep(outcome(), [browserWrite(), avail()]);
    expect(result.routed).toBe(true);
    if (result.routed) {
      expect(result.route.selectedSource).toBe("api");
      expect(result.route.reason).toMatch(/API produces an equivalent/);
    }
  });

  it("selects API even when the browser route is faster and cheaper", () => {
    const fastBrowser = { ...browserWrite(), estimatedLatencyMs: 100, estimatedCostUsd: 0 };
    const slowApi = avail({ estimatedLatencyMs: 5_000, estimatedCostUsd: 0.2 });
    const result = routeStep(outcome(), [fastBrowser, slowApi]);
    if (!result.routed) throw new Error("expected route");
    expect(result.route.selectedSource).toBe("api");
  });
});

describe("browser rules (rule 5)", () => {
  it("browser writes require a present user", () => {
    const result = routeStep(outcome({ userPresent: false }), [browserWrite()]);
    expect(result.routed).toBe(false);
  });

  it("browser writes must be approval-gated", () => {
    const unGated = { ...browserWrite(), requiresApproval: false };
    expect(routeStep(outcome(), [unGated]).routed).toBe(false);
  });

  it("browser writes can be disabled by policy", () => {
    const result = routeStep(outcome(), [browserWrite()], {
      ...DEFAULT_ROUTING_POLICY,
      allowSupervisedBrowserWrites: false,
    });
    expect(result.routed).toBe(false);
  });

  it("browser reads (page context) route without approval requirements", () => {
    const pageRead = avail({
      capabilityId: "page.extract_table",
      source: "browser_extension",
      scopes: [],
      riskLevel: "low",
      requiresApproval: false,
      requiresForeground: true,
    });
    const result = routeStep(
      outcome({ capabilityId: "page.extract_table", consequential: false, requiredScopes: [] }),
      [pageRead],
    );
    expect(result.routed).toBe(true);
    if (result.routed) expect(result.route.selectedSource).toBe("browser_extension");
  });
});

describe("accessibility and teach mode (rules 6–7)", () => {
  it("accessibility never performs consequential writes", () => {
    const ax = avail({ source: "macos_accessibility", scopes: [], riskLevel: "low" });
    expect(routeStep(outcome({ requiredScopes: [] }), [ax]).routed).toBe(false);
    // but reads are fine
    expect(routeStep(outcome({ consequential: false, requiredScopes: [] }), [ax]).routed).toBe(
      true,
    );
  });

  it("teach mode requires explicit activation", () => {
    const teach = avail({ source: "teach_mode", scopes: [], riskLevel: "medium" });
    expect(routeStep(outcome({ requiredScopes: [] }), [teach]).routed).toBe(false);
    expect(routeStep(outcome({ requiredScopes: [], teachModeActive: true }), [teach]).routed).toBe(
      true,
    );
  });
});

describe("no safe route (rule 8) and fallbacks (rule 9)", () => {
  it("asks the user when nothing is eligible", () => {
    const result = routeStep(outcome(), []);
    expect(result.routed).toBe(false);
    if (!result.routed) expect(result.askUser).toBe(true);
  });

  it("consequential steps NEVER fall back automatically (API failure ≠ browser write)", () => {
    const result = routeStep(outcome(), [avail(), browserWrite()]);
    if (!result.routed) throw new Error("expected route");
    expect(result.route.selectedSource).toBe("api");
    expect(result.route.fallbackSources).toEqual([]); // no silent fallback
    expect(result.route.onFailure).toBe("stop_and_ask_user");
  });

  it("non-consequential reads may try the next source on failure", () => {
    const apiRead = avail({ capabilityId: "salesforce.query_records", riskLevel: "low" });
    const browserRead = avail({
      capabilityId: "salesforce.query_records",
      source: "browser_extension",
      scopes: [],
      riskLevel: "low",
      requiresApproval: false,
      requiresForeground: true,
      reliabilityScore: 0.7,
    });
    const result = routeStep(
      outcome({ capabilityId: "salesforce.query_records", consequential: false }),
      [apiRead, browserRead],
    );
    if (!result.routed) throw new Error("expected route");
    expect(result.route.selectedSource).toBe("api");
    expect(result.route.fallbackSources).toEqual(["browser_extension"]);
    expect(result.route.onFailure).toBe("try_next_fallback");
  });
});

describe("verification (rule 10) and misc", () => {
  it("consequential writes demand independent-read verification", () => {
    const result = routeStep(outcome(), [avail()]);
    if (!result.routed) throw new Error("expected route");
    expect(result.route.verification).toBe("independent_read");
  });

  it("reads carry no verification requirement", () => {
    const result = routeStep(outcome({ consequential: false }), [avail()]);
    if (!result.routed) throw new Error("expected route");
    expect(result.route.verification).toBe("none");
  });

  it("critical-risk sources are never routable", () => {
    expect(routeStep(outcome(), [avail({ riskLevel: "critical" })]).routed).toBe(false);
  });

  it("degraded sources are penalized but usable, and the reason says so", () => {
    const healthy = avail({ reliabilityScore: 0.9 });
    const degraded = avail({ status: "degraded", reliabilityScore: 0.9 });
    expect(scoreRoute(degraded, outcome())).toBeLessThan(scoreRoute(healthy, outcome()));
    const result = routeStep(outcome(), [degraded]);
    if (!result.routed) throw new Error("expected route");
    expect(result.route.reason).toMatch(/degraded/);
  });

  it("routing is deterministic", () => {
    const inputs = [
      browserWrite(),
      avail(),
      avail({ source: "human", scopes: [], riskLevel: "low" }),
    ];
    const a = routeStep(outcome(), inputs);
    const b = routeStep(outcome(), inputs);
    expect(a).toEqual(b);
  });

  it("human routes exist as the explicit last resort", () => {
    const human = avail({
      source: "human",
      scopes: [],
      riskLevel: "low",
      requiresForeground: true,
    });
    const result = routeStep(outcome({ requiredScopes: [] }), [human]);
    if (!result.routed) throw new Error("expected route");
    expect(result.route.selectedSource).toBe("human");
    expect(result.route.reason).toMatch(/human performs the step/);
  });
});
