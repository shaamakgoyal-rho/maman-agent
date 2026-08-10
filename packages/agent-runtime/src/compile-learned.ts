import { getCapability } from "@maman/capability-catalog";
import {
  promptedInputs,
  uuidv7,
  workflowReadiness,
  type AgentSpec,
  type AgentStep,
  type LearnedStep,
  type LearnedWorkflow,
} from "@maman/contracts";
import { evaluateSpec, type OrgPolicy } from "@maman/policy-engine";
import { renderPlainLanguagePlan } from "./compiler.js";
import { validateAgentSpec } from "./validator.js";
import {
  describeMissingCapabilities,
  validateRuntimeCapabilities,
  type CapabilityRuntime,
} from "./runtime-capabilities.js";
import type { MissingConfiguration } from "./compiler.js";

/**
 * Compiles a workflow the USER configured, rather than one inferred from tokens.
 *
 * The difference is the whole point. `compileAgentSpec` starts from a
 * PatternCandidate — a sequence of roles and event types — and must decide what
 * the user meant. Every time it decided, it could be wrong in a way the user
 * would not notice until a write landed somewhere unexpected. This function
 * starts from a record where the targets, the values and the success conditions
 * were stated, so there is nothing left to infer: it TRANSLATES rather than
 * guesses, and refuses when the record is incomplete.
 *
 * It shares the validator, the policy engine and the runtime gate with the
 * inference path, so a configured workflow is held to exactly the same bars.
 */

export type CompileLearnedResult =
  | {
      status: "valid";
      spec: AgentSpec;
      plain_language_plan: string[];
      /** Audit trail: pattern → workflow(version) → spec. */
      compiled_from: {
        pattern_id: string;
        workflow_id: string;
        workflow_version: number;
        recipe: "learned-workflow";
      };
      warnings: string[];
    }
  | { status: "needs_configuration"; missing: MissingConfiguration[]; message: string }
  | { status: "needs_runtime"; runtime_id: string; missing: string[]; message: string }
  | { status: "blocked"; issues: Array<{ rule: string; message: string }>; message: string };

export interface CompileLearnedRequest {
  workflow: LearnedWorkflow;
  organization_id: string;
  owner_user_id: string;
  budgets: AgentSpec["budgets"];
  policy: OrgPolicy;
  policy_version_id: string;
  now: () => Date;
  runtime?: CapabilityRuntime;
  /**
   * The observed context a `workflow_start` trigger should match on, derived by
   * the caller from the source pattern's canonical tokens. Category-level only.
   */
  trigger_context?: { app_category: string; object_type?: string; origin?: string };
}

/**
 * Turns one configured step into a spec step.
 *
 * Bindings are TYPED, not stringly-passed: a prompt becomes an agent input the
 * run must collect, a step_output becomes a real reference the run engine
 * resolves, and a secret_ref stays a reference — the value is fetched by the
 * adapter at execution time and never enters the spec, which is persisted and
 * shown to the user.
 */
function toAgentStep(step: LearnedStep): AgentStep {
  const capability = getCapability(step.capability_id);
  const inputs: AgentStep["inputs"] = {};

  if (step.target) {
    inputs["target"] = { source: "literal", value: JSON.stringify(step.target) };
  }
  if (step.value) {
    switch (step.value.kind) {
      case "constant":
        inputs["value"] = { source: "literal", value: step.value.value };
        break;
      case "prompt":
        inputs["value"] = { source: "agent_input", ref: `${step.step_id}_value` };
        break;
      case "step_output":
        inputs["value"] = { source: "step_output", ref: step.value.step_id };
        break;
      case "secret_ref":
        // AgentSpec has no `secret_ref` binding source, and inventing one would
        // put a secret-shaped path into a persisted, user-visible spec. A secret
        // is modelled as a CONFIDENTIAL agent input instead: the spec carries the
        // key, the run resolves it from the device keychain, and the value never
        // enters the spec, a log or a prompt.
        inputs["value"] = { source: "agent_input", ref: `${step.step_id}_secret` };
        break;
    }
  }

  return {
    step_id: step.step_id,
    order: step.order,
    name: step.description,
    capability_id: step.capability_id,
    capability_version: capability?.version ?? 1,
    mode: step.mode,
    inputs,
    output_key: `${step.step_id}_out`,
    risk_level: capability?.risk_level ?? "low",
    // A configured write is still approval-gated. The user configuring a
    // workflow is not the same act as approving a specific run's changes.
    approval: {
      required: step.mode === "write",
      ...(step.mode === "write" ? { reason: "configured browser write" } : {}),
    },
    retry: {
      allowed: capability?.retry_class === "safe",
      max_attempts: capability?.retry_class === "safe" ? 3 : 0,
      backoff_seconds: capability?.retry_class === "safe" ? [1, 5, 30] : [],
    },
  };
}

/**
 * The trigger the user configured, carried into the spec instead of flattened.
 *
 * This used to read `trigger.type === "manual" ? {type:"manual"} : {type:"manual"}`
 * — every configured trigger became manual, which is the "trigger field that
 * nothing consumes" anti-pattern verbatim: the Teach flow let the user pick
 * when the agent should run, and compilation threw the answer away.
 *
 * `workflow_start` needs the observed context (which app category, which
 * origin) to become a matchable trigger; the workflow record does not carry
 * that, so the caller derives it from the source pattern and passes it in.
 * Without it the honest answer is manual — stated, not silently substituted.
 */
function toAgentTrigger(req: CompileLearnedRequest): AgentSpec["trigger"] {
  const trigger = req.workflow.trigger;
  if (trigger.type === "schedule") {
    return { type: "schedule", cron: trigger.cron, timezone: trigger.timezone };
  }
  if (trigger.type === "workflow_start" && req.trigger_context) {
    return {
      type: "context",
      app_category: req.trigger_context.app_category,
      ...(req.trigger_context.object_type ? { object_type: req.trigger_context.object_type } : {}),
      ...(req.trigger_context.origin ? { origin: req.trigger_context.origin } : {}),
      cooldown_seconds: 300,
    };
  }
  return { type: "manual" };
}

export function compileLearnedWorkflow(req: CompileLearnedRequest): CompileLearnedResult {
  // 1. INCOMPLETE CONFIGURATION IS THE FIRST GATE. Readiness is derived from
  //    the record's content every time, so a stale flag cannot authorise this.
  const readiness = workflowReadiness(req.workflow);
  if (!readiness.ready) {
    return {
      status: "needs_configuration",
      missing: readiness.missing.map((m) => ({
        kind:
          m.kind === "origin" || m.kind === "value" || m.kind === "success_condition"
            ? "workflow_definition"
            : m.kind,
        detail: m.detail,
      })),
      message: `This workflow needs ${readiness.missing.length} more thing${
        readiness.missing.length === 1 ? "" : "s"
      } before I can build it: ${readiness.missing[0]!.detail}`,
    };
  }

  // 2. Every capability must exist in the catalog before anything is built.
  const unknown = req.workflow.steps.filter((s) => !getCapability(s.capability_id));
  if (unknown.length > 0) {
    return {
      status: "blocked",
      issues: unknown.map((s) => ({
        rule: "C-CAP-UNKNOWN",
        message: `step ${s.step_id}: ${s.capability_id} is not a known capability`,
      })),
      message: `This workflow asks for something I don't have: ${unknown[0]!.capability_id}.`,
    };
  }

  const now = req.now();
  const inputs: AgentSpec["inputs"] = [
    ...promptedInputs(req.workflow).map((p) => ({
      key: `${p.step_id}_value`,
      label: p.label,
      type: "string" as const,
      required: p.required,
      sensitivity: "internal" as const,
      source: "user" as const,
    })),
    // Secret-backed steps declare a CONFIDENTIAL input whose value is resolved
    // from the keychain at run time. Declaring it makes the requirement visible
    // in the plan the user approves, rather than a hidden lookup.
    ...req.workflow.steps
      .filter((s) => s.value?.kind === "secret_ref")
      .map((s) => ({
        key: `${s.step_id}_secret`,
        label: `Stored secret for “${s.description}”`,
        type: "string" as const,
        required: true,
        sensitivity: "confidential" as const,
        source: "user" as const,
      })),
  ];

  const spec: AgentSpec = {
    schema_version: 1,
    agent_id: uuidv7({ timestampMs: now.getTime() }),
    version_id: uuidv7({ timestampMs: now.getTime() + 1 }),
    organization_id: req.organization_id,
    owner_user_id: req.owner_user_id,
    name: req.workflow.name,
    description: `Configured by you from a workflow Maman noticed ${req.workflow.steps.length} step${
      req.workflow.steps.length === 1 ? "" : "s"
    } long.`,
    generalized_intent: `learned:${req.workflow.workflow_id}`,
    source_pattern_id: req.workflow.source_pattern_id,
    state: "draft",
    trigger: toAgentTrigger(req),
    inputs,
    steps: [...req.workflow.steps].sort((a, b) => a.order - b.order).map(toAgentStep),
    assertions: [],
    budgets: req.budgets,
    failure_policy: {
      on_assertion_failure: "stop",
      on_tool_failure: "stop",
      max_safe_retries: 1,
      approval_timeout_minutes: 24 * 60,
    },
    created_at: now.toISOString(),
    created_by: "compiler",
  };

  // 3. The SAME static validator the inference path uses. A configured workflow
  //    gets no exemption: secret literals, URL literals and circular references
  //    are rejected here exactly as they would be for a generated spec.
  const validation = validateAgentSpec(spec);
  if (!validation.valid) {
    return {
      status: "blocked",
      issues: validation.issues.map((i) => ({ rule: i.rule, message: i.message })),
      message: `I could not build this safely: ${validation.issues[0]?.message ?? "validation failed"}`,
    };
  }

  // 4. Org policy.
  const decision = evaluateSpec(validation.spec, req.policy, {
    policy_version_id: req.policy_version_id,
    evaluated_at: now.toISOString(),
  });
  if (decision.decision === "deny") {
    return {
      status: "blocked",
      issues: decision.reasons.map((r) => ({ rule: r.rule_id, message: r.message })),
      message: `Organization policy blocked this: ${decision.reasons[0]?.message ?? ""}`,
    };
  }

  // 5. The runtime that will execute it.
  if (req.runtime) {
    const runtimeReadiness = validateRuntimeCapabilities(validation.spec, req.runtime);
    if (!runtimeReadiness.ready) {
      return {
        status: "needs_runtime",
        runtime_id: runtimeReadiness.runtime_id,
        missing: runtimeReadiness.missing.map((m) => m.capability_id),
        message: describeMissingCapabilities(runtimeReadiness.missing),
      };
    }
  }

  return {
    status: "valid",
    spec: validation.spec,
    plain_language_plan: renderPlainLanguagePlan(validation.spec),
    compiled_from: {
      pattern_id: req.workflow.source_pattern_id,
      workflow_id: req.workflow.workflow_id,
      workflow_version: req.workflow.version,
      recipe: "learned-workflow",
    },
    warnings:
      req.workflow.trigger.type !== "manual"
        ? [
            `The ${req.workflow.trigger.type} trigger is recorded but nothing runs it yet; this agent is manual for now.`,
          ]
        : [],
  };
}
