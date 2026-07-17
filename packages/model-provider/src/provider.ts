import { z } from "zod";

/**
 * ModelProvider interface. LLM output is UNTRUSTED DATA everywhere:
 * every response is parsed against a strict schema and rejected safely.
 * The model may only: name/summarize (copy), and generate a constrained
 * AgentSpec draft from catalog capability ids supplied in the prompt.
 * It can never change eligibility, risk, permissions, or projected value.
 */

export const namingInputSchema = z
  .object({
    /** Redacted structured summary — NEVER raw events. */
    generalized_intent: z.string(),
    app_categories: z.array(z.string()),
    object_type: z.string(),
    occurrence_count: z.number().int(),
    distinct_day_count: z.number().int(),
    median_duration_minutes: z.number(),
    redacted_steps: z.array(z.object({ order: z.number(), app: z.string(), action: z.string() })),
    /** The ONLY capability ids the model may reference. */
    allowed_capability_ids: z.array(z.string()),
  })
  .strict();
export type NamingInput = z.infer<typeof namingInputSchema>;

export const namingOutputSchema = z
  .object({
    title: z.string().min(4).max(80),
    summary: z.string().min(10).max(400),
    generalized_intent: z.string().min(3).max(80),
    capability_mapping: z.array(z.string()),
  })
  .strict();
export type NamingOutput = z.infer<typeof namingOutputSchema>;

export const compileInputSchema = z
  .object({
    generalized_intent: z.string(),
    desired_outcome: z.string().max(2000),
    canonical_steps: z.array(z.string()),
    allowed_capability_ids: z.array(z.string()),
    budgets: z.record(z.string(), z.number()),
  })
  .strict();
export type CompileInput = z.infer<typeof compileInputSchema>;

export type ModelUsage = {
  input_tokens: number;
  output_tokens: number;
  model_alias: string;
};

export type ModelResult<T> =
  | { ok: true; value: T; usage: ModelUsage }
  | { ok: false; error: "unavailable" | "invalid_output" | "policy_violation"; detail?: string };

export interface ModelProvider {
  readonly id: "demo" | "anthropic";
  /** Copy naming only — the caller keeps deterministic values authoritative. */
  nameRecommendation(input: NamingInput): Promise<ModelResult<NamingOutput>>;
  /**
   * Constrained AgentSpec step-plan generation (M6 compiler). Returns raw
   * JSON; the compiler validates it against the full AgentSpec schema,
   * static validator, and policy engine before anything is persisted.
   */
  draftAgentPlan(input: CompileInput): Promise<ModelResult<unknown>>;
}

/** Rejects any capability id that was not offered in the prompt. */
export function enforceCapabilityAllowlist(
  proposed: string[],
  allowed: string[],
): { ok: boolean; offending: string[] } {
  const allowedSet = new Set(allowed);
  const offending = proposed.filter((id) => !allowedSet.has(id));
  return { ok: offending.length === 0, offending };
}
