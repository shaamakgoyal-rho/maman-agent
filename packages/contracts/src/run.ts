import { z } from "zod";
import { utcTimestamp, uuid } from "./common.js";

export const agentRunStatus = z.enum([
  "queued",
  "validating",
  "running_read",
  "preparing_diff",
  "waiting_approval",
  "applying_write",
  "verifying",
  "completed",
  "completed_with_warnings",
  "failed",
  "cancelled",
  "expired",
  "budget_exceeded",
  "policy_blocked",
]);
export type AgentRunStatus = z.infer<typeof agentRunStatus>;

export const agentRunMode = z.enum(["shadow", "supervised", "active"]);
export type AgentRunMode = z.infer<typeof agentRunMode>;

/** JSON value type — agent inputs are parsed into this before any workflow starts. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const agentRunInputSchema = z
  .object({
    run_id: uuid,
    agent_id: uuid,
    agent_version_id: uuid,
    organization_id: uuid,
    owner_user_id: uuid,
    mode: agentRunMode,
    trigger: z
      .object({
        type: z.enum(["manual", "schedule", "event"]),
        actor_user_id: uuid.optional(),
        idempotency_key: z.string().min(1),
      })
      .strict(),
    /**
     * unknown only at the external boundary — parsed against the immutable
     * AgentSpec input definitions into a JsonValue map before workflow start.
     */
    agent_inputs: z.record(z.string(), jsonValueSchema),
    policy_version_id: uuid,
    requested_at: utcTimestamp,
  })
  .strict();

export type AgentRunInput = z.infer<typeof agentRunInputSchema>;

export const approveStepSignalSchema = z
  .object({
    run_id: uuid,
    step_id: z.string().min(1),
    diff_hash: z.string().min(1),
    approver_user_id: uuid,
    approval_token: z.string().min(1),
  })
  .strict();
export type ApproveStepSignal = z.infer<typeof approveStepSignalSchema>;

export const rejectStepSignalSchema = z
  .object({
    run_id: uuid,
    step_id: z.string().min(1),
    rejector_user_id: uuid,
    reason: z.string().min(1),
  })
  .strict();
export type RejectStepSignal = z.infer<typeof rejectStepSignalSchema>;

export const cancelRunSignalSchema = z
  .object({
    run_id: uuid,
    actor_user_id: uuid,
    reason: z.string().min(1),
  })
  .strict();
export type CancelRunSignal = z.infer<typeof cancelRunSignalSchema>;

/** Canonical idempotency key for a step's external write. */
export function stepIdempotencyKey(parts: {
  run_id: string;
  agent_version_id: string;
  step_id: string;
  capability_version: number;
  diff_hash: string;
}): string {
  return `${parts.run_id}:${parts.agent_version_id}:${parts.step_id}:${parts.capability_version}:${parts.diff_hash}`;
}

export const runStepSummarySchema = z
  .object({
    step_id: z.string().min(1),
    step_order: z.number().int().positive(),
    capability_id: z.string().min(1),
    mode: z.enum(["read", "propose_write", "write"]),
    status: z.enum(["pending", "running", "waiting_approval", "completed", "failed", "skipped"]),
    diff_sha256: z.string().optional(),
    error_code: z.string().optional(),
    started_at: utcTimestamp.optional(),
    completed_at: utcTimestamp.optional(),
  })
  .strict();
export type RunStepSummary = z.infer<typeof runStepSummarySchema>;
