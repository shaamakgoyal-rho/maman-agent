import { z } from "zod";
import { utcTimestamp, uuid } from "./common.js";

/**
 * Execution receipt — the immutable record every run produces.
 * ROI values carry explicit provenance: measured | inferred | estimated.
 * Estimated time saved is never presented as confirmed until enough manual
 * baseline observations exist.
 */

export const metricProvenance = z.enum(["measured", "inferred", "estimated"]);
export type MetricProvenance = z.infer<typeof metricProvenance>;

export const capabilitySourceUsed = z.enum([
  "api",
  "browser_extension",
  "macos_accessibility",
  "teach_mode",
  "human",
]);

export const receiptStepSchema = z
  .object({
    step_id: z.string().min(1),
    capability_id: z.string().min(1),
    source: capabilitySourceUsed,
    records_read: z.number().int().nonnegative(),
    writes_proposed: z.number().int().nonnegative(),
    writes_completed: z.number().int().nonnegative(),
    verification: z.enum(["independent_read_passed", "independent_read_failed", "none"]),
    duration_ms: z.number().int().nonnegative(),
    retries: z.number().int().nonnegative(),
    error_code: z.string().optional(),
  })
  .strict();

export const executionReceiptSchema = z
  .object({
    schema_version: z.literal(1),
    receipt_id: uuid,
    run_id: uuid,
    agent_id: uuid,
    agent_version_id: uuid,
    recipe_version: z.number().int().positive(),
    trigger: z.enum(["manual", "schedule", "event"]),
    mode: z.enum(["shadow", "supervised", "autonomous"]),
    started_at: utcTimestamp,
    completed_at: utcTimestamp,
    steps: z.array(receiptStepSchema),
    approvals: z.array(
      z
        .object({
          step_id: z.string(),
          approver_user_id: uuid,
          decided_at: utcTimestamp,
          decision: z.enum(["approved", "rejected"]),
        })
        .strict(),
    ),
    totals: z
      .object({
        records_read: z.number().int().nonnegative(),
        writes_proposed: z.number().int().nonnegative(),
        writes_completed: z.number().int().nonnegative(),
        duration_ms: z.number().int().nonnegative(),
        model_input_tokens: z.number().int().nonnegative(),
        model_output_tokens: z.number().int().nonnegative(),
        model_cost_usd: z.number().nonnegative(),
        provider_cost_usd: z.number().nonnegative(),
        total_cost_usd: z.number().nonnegative(),
      })
      .strict(),
    roi: z
      .object({
        manual_baseline_ms: z.number().int().nonnegative(),
        baseline_provenance: metricProvenance,
        /** Sample size behind the baseline; estimates need >= this to be "measured". */
        baseline_observation_count: z.number().int().nonnegative(),
        gross_time_saved_ms: z.number().int(),
        human_review_ms: z.number().int().nonnegative(),
        net_time_saved_ms: z.number().int(),
        savings_provenance: metricProvenance,
      })
      .strict(),
    outcome: z.enum(["completed", "completed_with_warnings", "failed", "cancelled"]),
    error_summary: z.string().optional(),
  })
  .strict();

export type ExecutionReceipt = z.infer<typeof executionReceiptSchema>;
export type ReceiptStep = z.infer<typeof receiptStepSchema>;

/** Baseline observations required before savings count as measured. */
export const MEASURED_BASELINE_MIN_OBSERVATIONS = 3;

/** Human phrasing the pet uses to summarize a receipt — honest by provenance. */
export function petReceiptSummary(receipt: ExecutionReceipt): string {
  const writes = receipt.totals.writes_completed;
  const exceptions = receipt.steps.filter((s) => s.error_code).length;
  const reviewed = receipt.approvals.length;
  const minutes = Math.max(0, Math.round(receipt.roi.net_time_saved_ms / 60_000));
  const cost = receipt.totals.total_cost_usd.toFixed(2);
  const parts: string[] = [];

  if (receipt.mode === "shadow") {
    parts.push(
      `Shadow run: I proposed ${receipt.totals.writes_proposed} change${receipt.totals.writes_proposed === 1 ? "" : "s"} and wrote nothing.`,
    );
  } else if (writes > 0) {
    parts.push(`Updated ${writes} record${writes === 1 ? "" : "s"}.`);
  } else {
    parts.push("Finished a read-only run.");
  }
  if (reviewed > 0) parts.push(`You reviewed ${reviewed} ${reviewed === 1 ? "step" : "steps"}.`);
  if (exceptions > 0)
    parts.push(`${exceptions} exception${exceptions === 1 ? "" : "s"} needed attention.`);
  if (receipt.mode !== "shadow") {
    const qualifier =
      receipt.roi.savings_provenance === "measured"
        ? "Saved approximately"
        : receipt.roi.savings_provenance === "inferred"
          ? "Likely saved about"
          : "Estimated (unconfirmed) savings:";
    parts.push(`${qualifier} ${minutes} minute${minutes === 1 ? "" : "s"}.`);
  }
  parts.push(`Execution cost: $${cost}.`);
  return parts.join(" ");
}
