import { z } from "zod";
import {
  capabilityRiskLevel,
  nonSecretString,
  schemaVersion1,
  utcTimestamp,
  uuid,
} from "./common.js";

/**
 * AgentSpec is declarative. It cannot contain source code, shell commands,
 * SQL strings, browser JavaScript, arbitrary URLs, or unbounded loops.
 * All object schemas are strict: unknown fields are rejected.
 */

export const agentState = z.enum([
  "draft",
  "shadow",
  "supervised",
  "active",
  "paused",
  "degraded",
  "revoked",
  "archived",
]);
export type AgentState = z.infer<typeof agentState>;

export const agentTriggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("manual") }).strict(),
  z
    .object({
      type: z.literal("schedule"),
      cron: z.string().min(1),
      timezone: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("event"),
      connector: z.string().min(1),
      event_name: z.string().min(1),
    })
    .strict(),
]);
export type AgentTrigger = z.infer<typeof agentTriggerSchema>;

export const agentInputSchema = z
  .object({
    key: z.string().min(1),
    label: z.string().min(1),
    type: z.enum(["string", "number", "boolean", "date", "record_reference", "file_reference"]),
    required: z.boolean(),
    sensitivity: z.enum(["public", "internal", "confidential"]),
    /**
     * Where the value comes from.
     *
     * `discovered_on_surface` means the agent resolves it by LOOKING at the
     * page it is on, before any step executes — the field it will act on, found
     * by matching what the user was observed doing against the controls that
     * are really there. It is not `user`: nobody types it in, and labelling it
     * so would put "you provide: the field to change" in front of someone who
     * provides no such thing. It is not `previous_step` either: discovery
     * happens before the first step, and its failure stops the run rather than
     * producing an output some later step consumes.
     */
    source: z.enum(["user", "trigger", "previous_step", "discovered_on_surface"]),
    source_ref: z.string().optional(),
  })
  .strict();
export type AgentInput = z.infer<typeof agentInputSchema>;

/** Step input bindings: literals must never be secret-shaped. */
export const stepInputBindingSchema = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("literal"),
      value: z.union([nonSecretString, z.number(), z.boolean()]),
    })
    .strict(),
  z
    .object({
      source: z.literal("agent_input"),
      ref: z.string().min(1),
    })
    .strict(),
  z
    .object({
      source: z.literal("step_output"),
      ref: z.string().min(1),
    })
    .strict(),
]);
export type StepInputBinding = z.infer<typeof stepInputBindingSchema>;

export const agentStepSchema = z
  .object({
    step_id: z.string().min(1),
    order: z.number().int().positive(),
    name: z.string().min(1),
    capability_id: z.string().min(1),
    capability_version: z.number().int().positive(),
    mode: z.enum(["read", "propose_write", "write"]),
    inputs: z.record(z.string(), stepInputBindingSchema),
    output_key: z.string().min(1),
    risk_level: capabilityRiskLevel,
    approval: z
      .object({
        required: z.boolean(),
        reason: z.string().optional(),
      })
      .strict(),
    retry: z
      .object({
        allowed: z.boolean(),
        max_attempts: z.number().int().min(0).max(5),
        backoff_seconds: z.array(z.number().int().positive()),
      })
      .strict(),
  })
  .strict();
export type AgentStep = z.infer<typeof agentStepSchema>;

/** Assertions use discriminated config schemas — no free-form config records. */
export const agentAssertionSchema = z.discriminatedUnion("type", [
  z
    .object({
      assertion_id: z.string().min(1),
      type: z.literal("record_count_between"),
      config: z
        .object({
          output_key: z.string().min(1),
          min: z.number().int().nonnegative(),
          max: z.number().int().nonnegative(),
        })
        .strict(),
      severity: z.enum(["warning", "blocking"]),
    })
    .strict(),
  z
    .object({
      assertion_id: z.string().min(1),
      type: z.literal("required_fields_present"),
      config: z
        .object({
          output_key: z.string().min(1),
          fields: z.array(z.string().min(1)).min(1),
        })
        .strict(),
      severity: z.enum(["warning", "blocking"]),
    })
    .strict(),
  z
    .object({
      assertion_id: z.string().min(1),
      type: z.literal("no_duplicate_keys"),
      config: z
        .object({
          output_key: z.string().min(1),
          key_field: z.string().min(1),
        })
        .strict(),
      severity: z.enum(["warning", "blocking"]),
    })
    .strict(),
  z
    .object({
      assertion_id: z.string().min(1),
      type: z.literal("diff_within_limit"),
      config: z
        .object({
          step_id: z.string().min(1),
          max_changes: z.number().int().nonnegative(),
        })
        .strict(),
      severity: z.enum(["warning", "blocking"]),
    })
    .strict(),
  z
    .object({
      assertion_id: z.string().min(1),
      type: z.literal("output_schema"),
      config: z
        .object({
          output_key: z.string().min(1),
          catalog_schema_id: z.string().min(1),
        })
        .strict(),
      severity: z.enum(["warning", "blocking"]),
    })
    .strict(),
  z
    .object({
      assertion_id: z.string().min(1),
      type: z.literal("custom_catalog_assertion"),
      config: z
        .object({
          catalog_assertion_id: z.string().min(1),
          params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
        })
        .strict(),
      severity: z.enum(["warning", "blocking"]),
    })
    .strict(),
]);
export type AgentAssertion = z.infer<typeof agentAssertionSchema>;

export const agentBudgetsSchema = z
  .object({
    max_runtime_seconds: z.number().int().positive(),
    max_model_tokens: z.number().int().nonnegative(),
    max_cost_usd: z.number().nonnegative(),
    max_records_read: z.number().int().nonnegative(),
    max_records_written: z.number().int().nonnegative(),
  })
  .strict();
export type AgentBudgets = z.infer<typeof agentBudgetsSchema>;

export const agentFailurePolicySchema = z
  .object({
    on_assertion_failure: z.literal("stop"),
    on_tool_failure: z.enum(["stop", "retry_safe"]),
    max_safe_retries: z.number().int().min(0).max(5),
    approval_timeout_minutes: z.number().int().positive(),
  })
  .strict();

export const agentSpecSchema = z
  .object({
    schema_version: schemaVersion1,
    agent_id: uuid,
    version_id: uuid,
    organization_id: uuid,
    owner_user_id: uuid,
    name: z.string().min(1).max(200),
    description: z.string(),
    generalized_intent: z.string(),
    source_pattern_id: uuid,
    state: agentState,
    trigger: agentTriggerSchema,
    inputs: z.array(agentInputSchema),
    steps: z.array(agentStepSchema),
    assertions: z.array(agentAssertionSchema),
    budgets: agentBudgetsSchema,
    failure_policy: agentFailurePolicySchema,
    created_at: utcTimestamp,
    created_by: z.enum(["user", "compiler"]),
  })
  .strict();

export type AgentSpec = z.infer<typeof agentSpecSchema>;
