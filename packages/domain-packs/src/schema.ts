import { z } from "zod";

/**
 * Domain pack schema — the enforcing implementation of `domain/pack.schema.json`
 * (that file is the published contract for editors; this is what actually
 * validates at load time, since Zod is already a workspace dependency).
 *
 * A pack is the single source of domain truth: taxonomy, seed workflow
 * templates, policy, and proactivity tuning. This package is GENERIC — it
 * contains no FinOps or RevOps knowledge, so a third domain is addable by
 * writing YAML only.
 *
 * Pure: no fs, no network, no LLM. Packs are read and compiled to JSON by
 * `scripts/build-packs.ts` (pnpm packs:generate); every consumer receives them as data.
 */

const identifier = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/, "must be lower_snake_case");

/** Autonomy is a CEILING: policy may lower it, never raise it. */
export const autonomyLevel = z.enum([
  "draft_only",
  "stage_only",
  "dry_run_first",
  "never_autonomous",
]);
export type AutonomyLevel = z.infer<typeof autonomyLevel>;

/** Ordered from most to least permissive, so a ceiling can be min()'d. */
export const AUTONOMY_ORDER: AutonomyLevel[] = [
  "dry_run_first",
  "stage_only",
  "draft_only",
  "never_autonomous",
];

/** The stricter (lower) of two ceilings. Policy can only restrict. */
export function lowerCeiling(a: AutonomyLevel, b: AutonomyLevel): AutonomyLevel {
  return AUTONOMY_ORDER.indexOf(a) >= AUTONOMY_ORDER.indexOf(b) ? a : b;
}

const detectionHints = z
  .object({
    app_categories: z.array(z.string()).default([]),
    /**
     * Matched against label text INSIDE the observer boundary, pre-hash. Only
     * the derived domain tuple is ever emitted — raw label text never leaves
     * the observer process.
     */
    label_patterns: z.array(z.string().min(1)).default([]),
    target_roles: z.array(z.string()).default([]),
  })
  .strict();

export const packObject = z
  .object({
    id: identifier,
    aliases: z.array(identifier).default([]),
    detection_hints: detectionHints.default({}),
  })
  .strict();

export const packAction = z
  .object({
    id: identifier,
    risk: z.enum(["none", "low", "medium", "high", "critical"]),
    on: z.array(z.string()).default([]),
  })
  .strict();

export const packCadence = z.enum([
  "continuous",
  "fiscal_monthly",
  "weekly",
  "date_driven",
  "event_driven",
]);
export type PackCadence = z.infer<typeof packCadence>;

/** One signature step: [domain_action, domain_object, target_role]. */
export const signatureStep = z.tuple([z.string().min(1), z.string().min(1), z.string().min(1)]);

export const packWorkflow = z
  .object({
    id: identifier,
    name: z.string().min(1),
    cadence: packCadence,
    signature: z.array(signatureStep).min(1),
    min_reps_with_template: z.number().int().min(1).max(50).default(2),
    trigger: z
      .object({ opening_ngram: z.number().int().min(1).max(10) })
      .strict()
      .optional(),
    default_autonomy_ceiling: autonomyLevel.optional(),
    pre_stage: z
      .object({
        days_before_close: z.number().int().min(0).max(60).optional(),
        days_before_renewal: z.number().int().min(0).max(365).optional(),
        mode: autonomyLevel.optional(),
      })
      .strict()
      .optional(),
    notes: z.string().optional(),
  })
  .strict();

export const packPolicy = z
  .object({
    segregation_of_duties: z
      .array(z.object({ cannot_combine: z.array(identifier).min(2) }).strict())
      .default([]),
    autonomy_rules: z
      .array(
        z
          .object({
            match: z
              .object({
                action: identifier,
                amount_usd_gt: z.number().min(0).optional(),
                discount_pct_gt: z.number().min(0).max(100).optional(),
                record_count_gt: z.number().int().min(0).optional(),
              })
              .strict(),
            rule: z
              .object({
                max_level: autonomyLevel.optional(),
                always_gate: z.boolean().optional(),
                dual_control: z.boolean().optional(),
              })
              .strict()
              .refine((r) => Object.keys(r).length > 0, "rule must set at least one effect"),
          })
          .strict(),
      )
      .default([]),
    receipts: z
      .object({
        immutable: z.boolean().default(false),
        retain_days: z.number().int().min(1).max(3650).optional(),
      })
      .strict()
      .optional(),
    /** Low extractor confidence must fail CLOSED (treated as threshold exceeded). */
    amount_extraction_required_for: z.array(identifier).default([]),
    crm_write_safety: z
      .object({
        snapshot_before_write: z.boolean().default(false),
        revert_command: z.boolean().default(false),
      })
      .strict()
      .optional(),
  })
  .strict();

export const packProactivity = z
  .object({
    calendar: z.enum(["fiscal", "none"]).default("none"),
    quiet_periods: z
      .array(
        z
          .object({
            start: z.string(),
            end: z.string(),
            label: z.string().optional(),
          })
          .strict(),
      )
      .default([]),
    event_triggers: z
      .array(
        z
          .object({
            watch: identifier,
            field: z.string().optional(),
            lead_days: z.number().int().min(0).max(365).optional(),
            condition: z.string().optional(),
            surface: z.string().optional(),
            copy: z.string().optional(),
          })
          .strict(),
      )
      .default([]),
    suggestion_timing: z
      .record(
        z.string(),
        z
          .object({
            surface: z.string().optional(),
            days_before: z.number().int().min(0).max(60).optional(),
            copy: z.string().optional(),
          })
          .strict(),
      )
      .default({}),
    dismissal_learning: z
      .object({
        source: z.string().optional(),
        never_means: z.enum(["suppress_workflow_family", "suppress_pattern"]).optional(),
        not_now_backoff_days: z.array(z.number().int().min(1).max(365)).default([]),
      })
      .strict()
      .optional(),
  })
  .strict();

export const domainPackSchema = z
  .object({
    domain: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    objects: z.array(packObject).min(1),
    actions: z.array(packAction).min(1),
    workflows: z.array(packWorkflow).min(1),
    policy: packPolicy.default({}),
    proactivity: packProactivity.default({}),
  })
  .strict();

export type DomainPack = z.infer<typeof domainPackSchema>;
export type PackObject = z.infer<typeof packObject>;
export type PackAction = z.infer<typeof packAction>;
export type PackWorkflow = z.infer<typeof packWorkflow>;
