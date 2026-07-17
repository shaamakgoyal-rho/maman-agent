import { z } from "zod";
import { utcTimestamp, uuid } from "./common.js";

export const policyDecisionSchema = z
  .object({
    decision: z.enum(["allow", "require_approval", "deny"]),
    policy_version_id: uuid,
    evaluated_at: utcTimestamp,
    reasons: z.array(
      z
        .object({
          code: z.string().min(1),
          message: z.string().min(1),
          rule_id: z.string().min(1),
        })
        .strict(),
    ),
    limits: z
      .object({
        max_records: z.number().int().nonnegative().optional(),
        max_cost_usd: z.number().nonnegative().optional(),
        expires_at: utcTimestamp.optional(),
      })
      .strict(),
  })
  .strict();

export type PolicyDecision = z.infer<typeof policyDecisionSchema>;
