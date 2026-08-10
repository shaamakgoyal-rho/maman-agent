import { looksLikeSecret } from "@maman/contracts";
import { z } from "zod";

/**
 * ModelProvider interface. LLM output is UNTRUSTED DATA everywhere:
 * every response is parsed against a strict schema and rejected safely.
 * The model may only: name/summarize (copy), and generate a constrained
 * AgentSpec draft from catalog capability ids supplied in the prompt.
 * It can never change eligibility, risk, permissions, or projected value.
 *
 * WHAT GOES *IN* IS A BOUNDARY TOO, and it was not being treated as one.
 *
 * "Secret material never enters logs, analytics, prompts, or AgentSpec" is a
 * standing invariant, and three of those four were enforced structurally:
 * `browserActionSchema` bounds every field with `boundedNonSecret`, the
 * redaction gate masks credential regions before a frame is egressed, and the
 * logger redacts. The PROMPT — named explicitly in that sentence — had nothing.
 * Every field below was a bare `z.string()` under a comment reading "NEVER raw
 * events", and the Anthropic provider builds its prompt with
 * `JSON.stringify(input)` without parsing the input at all. TypeScript types are
 * erased before the wire, so the comment was the only thing standing between a
 * captured value and Anthropic.
 */

/**
 * Free text that may be sent to a model.
 *
 * Bounded AND secret-refusing, for the same reason `boundedNonSecret` exists on
 * the browser wire: an unbounded field is an exfiltration channel, and a
 * credential-shaped one is a leak whatever its length.
 */
const promptSafeText = (max: number) =>
  z
    .string()
    .max(max)
    .refine((v) => !looksLikeSecret(v), {
      message: "value matches a secret shape and must not be sent to a model",
    });

export const namingInputSchema = z
  .object({
    /** Redacted structured summary — NEVER raw events. */
    generalized_intent: promptSafeText(120),
    app_categories: z.array(promptSafeText(60)),
    object_type: promptSafeText(60),
    occurrence_count: z.number().int(),
    distinct_day_count: z.number().int(),
    median_duration_minutes: z.number(),
    redacted_steps: z.array(
      z.object({
        order: z.number(),
        app: promptSafeText(60),
        // The canonical token. Category-level by construction
        // (`source:app_category:event_type:target_role:semantic_type:object_type`),
        // but a source that ever put a captured value in a segment would send it
        // here, so the bound is on the field rather than on the convention.
        action: promptSafeText(200),
      }),
    ),
    /** The ONLY capability ids the model may reference. */
    allowed_capability_ids: z.array(promptSafeText(120)),
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
    generalized_intent: promptSafeText(120),
    // The one genuinely free-text field: the user's own description of what
    // they want. Bounded before, unguarded against secrets until now — and it
    // is the field most likely to contain one, because a person pasting an
    // example of the work may paste a token with it.
    desired_outcome: promptSafeText(2000),
    canonical_steps: z.array(promptSafeText(200)),
    allowed_capability_ids: z.array(promptSafeText(120)),
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
