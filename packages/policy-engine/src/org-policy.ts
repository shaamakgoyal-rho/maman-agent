import { z } from "zod";

/**
 * Organization policy document (immutable versions; spec §21).
 * Deterministic data — the policy engine never calls an LLM.
 */

export const orgPolicySchema = z
  .object({
    schema_version: z.literal(1),
    enabled_connectors: z.array(
      z.enum(["salesforce", "google_sheets", "gmail", "google_calendar", "browser", "local"]),
    ),
    /** Explicit capability allowlist; "catalog" means every catalog capability. */
    allowed_capabilities: z.union([
      z.literal("catalog"),
      z.array(z.object({ id: z.string(), version: z.number().int() }).strict()),
    ]),
    disabled_capabilities: z.array(z.string()).default([]),
    max_records_read: z.number().int().positive().max(100_000),
    max_records_written: z.number().int().positive().max(500),
    /** Medium-risk capabilities the org allows unattended in supervised mode. */
    unattended_medium_capabilities: z.array(z.string()).default([]),
    max_run_cost_usd: z.number().positive(),
    max_monthly_model_cost_usd: z.number().positive(),
    allow_scheduled_supervised: z.boolean().default(false),
    /** Aggregate suppression cohort — never below five. */
    min_cohort_size: z.number().int().min(5).default(5),
    allow_pattern_sharing: z.boolean().default(true),
    local_retention_days: z.number().int().min(1).max(90).default(30),
    /** Model routing: whether redacted summaries may leave the device. */
    allow_remote_model: z.boolean().default(true),
  })
  .strict();

export type OrgPolicy = z.infer<typeof orgPolicySchema>;

export const DEFAULT_ORG_POLICY: OrgPolicy = orgPolicySchema.parse({
  schema_version: 1,
  enabled_connectors: [
    "salesforce",
    "google_sheets",
    "gmail",
    "google_calendar",
    "browser",
    "local",
  ],
  allowed_capabilities: "catalog",
  disabled_capabilities: [],
  max_records_read: 10_000,
  max_records_written: 500,
  unattended_medium_capabilities: [],
  max_run_cost_usd: 5,
  max_monthly_model_cost_usd: 250,
  allow_scheduled_supervised: false,
  min_cohort_size: 5,
  allow_pattern_sharing: true,
  local_retention_days: 30,
  allow_remote_model: true,
});
