import { z } from "zod";

/**
 * Shadow comparison engine. During shadowing:
 * - NO consequential writes exist by construction (the input type only admits
 *   proposed changes — there is no completed-write field to smuggle).
 * - The proposed result is compared with the user's real outcome.
 * - Promotion needs a configurable number of successful comparisons.
 */

export const proposedChangeSchema = z
  .object({
    object_ref: z.string().min(1), // stable hash reference, never raw ids
    field: z.string().min(1),
    proposed_value_hash: z.string().min(1), // hashes, never raw values
  })
  .strict();
export type ProposedChange = z.infer<typeof proposedChangeSchema>;

export type ShadowComparison = {
  run_id: string;
  agreement: number; // 0..1
  matched: number;
  missed: number; // user did it, shadow did not propose it
  extra: number; // shadow proposed it, user did not do it
  missing_rules: string[]; // human-readable gaps for "what Maman learned"
};

export function compareShadowRun(
  runId: string,
  proposed: ProposedChange[],
  actual: ProposedChange[],
): ShadowComparison {
  const key = (c: ProposedChange) => `${c.object_ref}|${c.field}|${c.proposed_value_hash}`;
  const proposedSet = new Set(proposed.map(key));
  const actualSet = new Set(actual.map(key));

  let matched = 0;
  for (const k of proposedSet) if (actualSet.has(k)) matched++;
  const extra = proposedSet.size - matched;
  const missed = actualSet.size - matched;
  const union = proposedSet.size + actualSet.size - matched;
  const agreement = union === 0 ? 1 : matched / union;

  const missing_rules: string[] = [];
  const missedFields = new Set(actual.filter((c) => !proposedSet.has(key(c))).map((c) => c.field));
  for (const field of missedFields) {
    missing_rules.push(`You also update "${field}" — I haven't learned when to change it yet.`);
  }
  const extraFields = new Set(proposed.filter((c) => !actualSet.has(key(c))).map((c) => c.field));
  for (const field of extraFields) {
    missing_rules.push(
      `I proposed changing "${field}" but you didn't — tell me when that's wrong.`,
    );
  }

  return {
    run_id: runId,
    agreement: Math.round(agreement * 1000) / 1000,
    matched,
    missed,
    extra,
    missing_rules,
  };
}

export type PromotionReadiness = {
  ready: boolean;
  successful_comparisons: number;
  required_comparisons: number;
  latest_agreement: number | null;
};

export const DEFAULT_REQUIRED_COMPARISONS = 3;
export const SUCCESS_AGREEMENT_THRESHOLD = 0.9;

/** A comparison "succeeds" at ≥0.9 agreement; promotion needs N successes. */
export function promotionReadiness(
  comparisons: ShadowComparison[],
  requiredComparisons: number = DEFAULT_REQUIRED_COMPARISONS,
): PromotionReadiness {
  const successful = comparisons.filter((c) => c.agreement >= SUCCESS_AGREEMENT_THRESHOLD).length;
  return {
    ready: successful >= requiredComparisons,
    successful_comparisons: successful,
    required_comparisons: requiredComparisons,
    latest_agreement: comparisons.at(-1)?.agreement ?? null,
  };
}
