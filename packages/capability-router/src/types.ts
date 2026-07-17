import { z } from "zod";

/**
 * Capability Router contracts. Every agent step declares the SEMANTIC OUTCOME
 * it needs; the router selects the safest, most reliable execution source.
 */

export const capabilitySourceSchema = z.enum([
  "api",
  "browser_extension",
  "macos_accessibility",
  "teach_mode",
  "human",
]);
export type CapabilitySource = z.infer<typeof capabilitySourceSchema>;

export const capabilityAvailabilitySchema = z
  .object({
    capabilityId: z.string().min(1),
    source: capabilitySourceSchema,
    status: z.enum(["available", "unavailable", "permission_required", "degraded"]),
    scopes: z.array(z.string()),
    riskLevel: z.enum(["low", "medium", "high", "critical"]),
    /** 0..1 observed reliability. */
    reliabilityScore: z.number().min(0).max(1),
    estimatedLatencyMs: z.number().nonnegative(),
    estimatedCostUsd: z.number().nonnegative(),
    requiresForeground: z.boolean(),
    requiresApproval: z.boolean(),
  })
  .strict();
export type CapabilityAvailability = z.infer<typeof capabilityAvailabilitySchema>;

export const executionRouteSchema = z
  .object({
    stepId: z.string().min(1),
    selectedSource: capabilitySourceSchema,
    fallbackSources: z.array(capabilitySourceSchema),
    reason: z.string().min(1),
    estimatedCostUsd: z.number().nonnegative(),
    confidence: z.number().min(0).max(1),
    /** Consequential writes must be verified by an independent read. */
    verification: z.enum(["independent_read", "none"]),
    /** What happens when the selected source fails at runtime. */
    onFailure: z.enum(["try_next_fallback", "stop_and_ask_user"]),
  })
  .strict();
export type ExecutionRoute = z.infer<typeof executionRouteSchema>;

/** A step's declared semantic outcome (never a hard-coded click sequence). */
export const stepOutcomeSchema = z
  .object({
    stepId: z.string().min(1),
    /** e.g. "salesforce.update_fields", "page.extract_table" */
    capabilityId: z.string().min(1),
    /** Does this step change external state? */
    consequential: z.boolean(),
    /** Required OAuth scopes / permissions for the outcome. */
    requiredScopes: z.array(z.string()).default([]),
    /** Whether the user explicitly started Teach Mode this session. */
    teachModeActive: z.boolean().default(false),
    /** Whether a user is present (foreground/supervised execution possible). */
    userPresent: z.boolean().default(false),
  })
  .strict();
export type StepOutcome = z.infer<typeof stepOutcomeSchema>;

export type RoutingPolicy = {
  /** Sources blocked by company policy. */
  blockedSources: CapabilitySource[];
  /** Capability ids blocked by company or user policy. */
  blockedCapabilities: string[];
  /** Whether browser writes are permitted at all (always supervised). */
  allowSupervisedBrowserWrites: boolean;
  /** Per-run cost ceiling. */
  maxStepCostUsd: number;
};

export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  blockedSources: [],
  blockedCapabilities: [],
  allowSupervisedBrowserWrites: true,
  maxStepCostUsd: 1,
};
