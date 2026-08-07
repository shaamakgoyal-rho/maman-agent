import { z } from "zod";
import { looksLikeSecret, utcTimestamp, uuid } from "./common.js";
import { browserTargetSchema } from "./browser-action.js";

/**
 * A LEARNED WORKFLOW — what observation saw, plus what only the user can tell us.
 *
 * This type exists because passive observation and executable automation need
 * different things, and conflating them produced the worst defects in this
 * codebase. The pattern engine can prove a workflow REPEATS: it sees that a text
 * field changed, four times, on three days. It cannot see which field mattered,
 * where the new value came from, or what "done correctly" looks like — the
 * observer deliberately never records values, and a canonical token carries a
 * role, not a meaning.
 *
 * Every time the compiler filled that gap by inference it produced a helper the
 * user had not described: an observed CRM edit became a CSV reconciliation agent
 * demanding a file nobody mentioned; a browser read was answered with Salesforce
 * fixtures. So the gap is now a TYPE. A workflow is not executable until the
 * missing pieces are supplied, and `missing_configuration` says exactly which
 * ones are still absent.
 *
 * Lifecycle:
 *   PatternCandidate  (observation: this repeats)
 *     → AutomationOpportunity  (this repeats and could be automated)
 *     → teach/configure session  (the user supplies what was never observable)
 *     → LearnedWorkflow  (executable intent, fully specified)
 *     → AgentSpec  (compiled, validated, runtime-checked)
 *     → shadow → supervised → verified agent
 *
 * PRIVACY. A configured value may be something the user typed — an account name,
 * an email, a note. Those live here in plaintext ONLY when the user marked them
 * as safe; anything sensitive is held as `secret_ref`, a pointer into the
 * device keychain, and the value itself never enters this record, a prompt, a
 * log or a sync payload. `looksLikeSecret` rejects credential-shaped literals
 * outright, so a password cannot be stored as a "constant" by mistake.
 */

/** Text the user configured. Never credential-shaped, always bounded. */
const configuredText = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .refine((v) => !looksLikeSecret(v), {
      message:
        "this looks like a credential; Maman will not store it in a workflow — use a secret reference",
    });

/**
 * Where a step's value comes from. The four cases are exhaustive on purpose:
 * anything that is not one of them is a value we would be inventing.
 */
export const valueSourceSchema = z.discriminatedUnion("kind", [
  /** A fixed value the user typed while configuring. */
  z.object({ kind: z.literal("constant"), value: configuredText(0, 512) }).strict(),
  /**
   * Ask the user each run. `label` is what they see; there is no default,
   * because a default the user never confirmed is a guess.
   */
  z
    .object({
      kind: z.literal("prompt"),
      label: configuredText(1, 120),
      required: z.boolean().default(true),
    })
    .strict(),
  /** The output of an earlier step in this workflow. */
  z
    .object({
      kind: z.literal("step_output"),
      step_id: z.string().min(1).max(120),
      /** Field within that output, e.g. a column or a read field's name. */
      path: configuredText(1, 120),
    })
    .strict(),
  /**
   * A value held in the device keychain. The VALUE never appears here — only the
   * reference — so this record can be read, logged or shown without exposing it.
   */
  z.object({ kind: z.literal("secret_ref"), ref: z.string().min(1).max(200) }).strict(),
]);
export type ValueSource = z.infer<typeof valueSourceSchema>;

/**
 * How a step proves it worked. `readback` is the honest default for a write:
 * re-read the field and compare. `none` is allowed only for reads, because a
 * write that cannot be checked cannot be reported as verified.
 */
export const successConditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("readback_equals") }).strict(),
  z
    .object({
      kind: z.literal("field_contains"),
      target: browserTargetSchema,
      text: configuredText(1, 200),
    })
    .strict(),
  z.object({ kind: z.literal("none") }).strict(),
]);
export type SuccessCondition = z.infer<typeof successConditionSchema>;

/** One configured step: what to do, to what, with which value, and how it is checked. */
export const learnedStepSchema = z
  .object({
    step_id: z.string().min(1).max(120),
    order: z.number().int().positive(),
    /** Plain language, shown in the plan the user approves. */
    description: configuredText(1, 200),
    capability_id: z.string().min(1).max(120),
    mode: z.enum(["read", "propose_write", "write"]),
    /**
     * The control, addressed the way a person would: role + accessible name.
     * Absent for steps that do not target a control (e.g. a navigation).
     */
    target: browserTargetSchema.optional(),
    /** Required for write steps; a write with no value has nothing to write. */
    value: valueSourceSchema.optional(),
    success: successConditionSchema.default({ kind: "readback_equals" }),
  })
  .strict()
  .refine((s) => s.mode === "read" || s.value !== undefined, {
    message: "a write step must say where its value comes from",
  })
  .refine((s) => s.mode === "read" || s.success.kind !== "none", {
    message: "a write step must be checkable; 'none' is only valid for reads",
  });
export type LearnedStep = z.infer<typeof learnedStepSchema>;

/** What is still missing before this workflow can be compiled. */
export const missingConfigurationSchema = z
  .object({
    kind: z.enum([
      "data_source",
      "field_mapping",
      "target",
      "value",
      "success_condition",
      "origin",
      "workflow_definition",
    ]),
    detail: z.string().min(1).max(300),
    /** Which step needs it, when the gap is step-specific. */
    step_id: z.string().max(120).optional(),
  })
  .strict();
export type MissingConfigurationItem = z.infer<typeof missingConfigurationSchema>;

/** When the workflow should run. Only `manual` is honoured today. */
export const workflowTriggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("manual") }).strict(),
  z
    .object({
      type: z.literal("workflow_start"),
      /** The pattern signature whose appearance stages this workflow. */
      pattern_signature: z.string().min(1).max(200),
    })
    .strict(),
  z
    .object({
      type: z.literal("schedule"),
      cron: z.string().min(1).max(120),
      timezone: z.string().min(1).max(64),
    })
    .strict(),
]);
export type WorkflowTrigger = z.infer<typeof workflowTriggerSchema>;

export const learnedWorkflowSchema = z
  .object({
    schema_version: z.literal(1),
    workflow_id: uuid,
    /** Bumped on every material edit; a compiled agent records which it used. */
    version: z.number().int().positive(),
    /** The observed pattern this came from — the audit trail's first link. */
    source_pattern_id: uuid,
    owner_user_id: uuid,
    name: configuredText(1, 120),
    trigger: workflowTriggerSchema,
    /**
     * Origins this workflow may touch, in full (scheme + host). Compared
     * exactly. Empty means the workflow cannot run: there is nowhere it is
     * allowed to act.
     */
    allowed_origins: z.array(z.string().url().startsWith("https://")).max(8),
    steps: z.array(learnedStepSchema).max(20),
    missing_configuration: z.array(missingConfigurationSchema),
    /**
     * How much of this came from observation vs the user. Recorded because a
     * step the user confirmed and a step Maman guessed deserve different trust,
     * and a reader should be able to tell them apart.
     */
    provenance: z.enum(["observed", "user_configured", "mixed"]),
    created_at: utcTimestamp,
    updated_at: utcTimestamp,
  })
  .strict();
export type LearnedWorkflow = z.infer<typeof learnedWorkflowSchema>;

/**
 * Whether this workflow can be compiled at all.
 *
 * Deliberately NOT a boolean on the record: readiness is derived from the
 * content every time it is asked, so a stale "ready: true" written before an
 * edit can never authorise a compile.
 */
export function workflowReadiness(workflow: LearnedWorkflow): {
  ready: boolean;
  missing: MissingConfigurationItem[];
} {
  const missing: MissingConfigurationItem[] = [...workflow.missing_configuration];

  if (workflow.allowed_origins.length === 0) {
    missing.push({
      kind: "origin",
      detail: "No site is allowed for this workflow, so there is nowhere it may act.",
    });
  }
  if (workflow.steps.length === 0) {
    missing.push({
      kind: "workflow_definition",
      detail: "This workflow has no steps yet.",
    });
  }

  for (const step of workflow.steps) {
    // A step that acts on a control must know which control.
    if (step.capability_id.startsWith("browser.") && step.target === undefined) {
      missing.push({
        kind: "target",
        step_id: step.step_id,
        detail: `Step ${step.order} does not say which field it acts on.`,
      });
    }
    if (step.mode !== "read" && step.value === undefined) {
      missing.push({
        kind: "value",
        step_id: step.step_id,
        detail: `Step ${step.order} does not say where its value comes from.`,
      });
    }
    // A step_output reference must point at a step that actually precedes it —
    // a forward or self reference is unsatisfiable at run time.
    if (step.value?.kind === "step_output") {
      const sourceId = step.value.step_id;
      const source = workflow.steps.find((s) => s.step_id === sourceId);
      if (!source || source.order >= step.order) {
        missing.push({
          kind: "field_mapping",
          step_id: step.step_id,
          detail: `Step ${step.order} takes its value from a step that does not run before it.`,
        });
      }
    }
  }

  return { ready: missing.length === 0, missing };
}

/** Steps whose value the user must supply at run time. */
export function promptedInputs(
  workflow: LearnedWorkflow,
): Array<{ step_id: string; label: string; required: boolean }> {
  return workflow.steps.flatMap((step) =>
    step.value?.kind === "prompt"
      ? [{ step_id: step.step_id, label: step.value.label, required: step.value.required }]
      : [],
  );
}
