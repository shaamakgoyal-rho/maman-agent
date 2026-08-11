import {
  traceReadiness,
  uuidv7,
  type AgentSpec,
  type LocalActionTrace,
  type ObservedAction,
  type MissingConfigurationItem,
} from "@maman/contracts";

/**
 * THE TRACE COMPILER — LocalActionTrace → AgentSpec, deterministically.
 *
 * THE GAP THIS CLOSES. Traces were captured (browser + AX), stored encrypted,
 * and read by nothing: `action-trace.ts` was the only module in the product that
 * referenced them. Compilation instead went through `compile-learned.ts`, whose
 * two recipes are "Salesforce reconciliation" and "generic browser workflow", so
 * an observed routine was matched to a recipe rather than translated. That is why
 * a workflow Maman genuinely watched could still end in a configuration form: the
 * evidence existed and nothing consumed it.
 *
 * WHAT MAKES THIS DIFFERENT FROM A RECIPE MATCHER:
 *  - Every step comes from an ObservedAction. There is no catalogue of shapes to
 *    fall into, so a browser trace cannot become a Salesforce agent — the only
 *    thing this can emit is what was seen.
 *  - Deterministic and model-free. Same trace in, byte-identical spec out; no
 *    provider is constructed, so no hosted key can be read even by accident.
 *  - Provenance is carried, not implied: the spec records which pattern and
 *    which trace produced it, and which compiler version did the work, so a
 *    reviewer can go back to the evidence.
 *  - It REFUSES rather than guesses. An unsupported operation, an unstable
 *    target, or a protected hole in the middle of the routine returns typed
 *    `missing_configuration`, which the UI renders as one question — not a form.
 */

/** Identity recorded in every spec this module produces. */
export const TRACE_COMPILER_ID = "deterministic-local";
export const TRACE_COMPILER_VERSION = 1;

/**
 * Trace operations this compiler can execute today, mapped to the capabilities
 * the browser adapter actually registers.
 *
 * A narrow, honest map. An operation absent from here is REFUSED by name rather
 * than approximated with a neighbouring capability — "press" is not "set_value",
 * and pretending otherwise is how an agent does something the user never saw.
 */
const BROWSER_OPERATIONS: Record<
  string,
  { capability: string; mode: AgentSpec["steps"][number]["mode"] }
> = {
  read_field: { capability: "browser.extract_structured_fields", mode: "read" },
  list_controls: { capability: "browser.extract_structured_fields", mode: "read" },
  set_value: { capability: "browser.propose_form_fill", mode: "propose_write" },
  press: { capability: "browser.press_control", mode: "propose_write" },
};

export type TraceCompileRequest = {
  trace: LocalActionTrace;
  /** The pattern whose repetitions this trace represents. */
  pattern_id: string;
  owner_user_id: string;
  organization_id: string;
  /** Plain-language name from the recommendation (never invented here). */
  name: string;
  /** Capability ids the runtime can really execute right now. */
  availableCapabilities: ReadonlySet<string>;
  now?: () => Date;
};

export type TraceCompileResult =
  | { ok: true; spec: AgentSpec; provenance: TraceProvenance }
  | { ok: false; missing_configuration: MissingConfigurationItem[]; detail: string };

/** pattern → trace → spec, so the evidence for an agent is always reachable. */
export type TraceProvenance = {
  pattern_id: string;
  trace_id: string;
  compiler: string;
  compiler_version: number;
  /** Steps in the trace that became steps in the spec. */
  compiled_steps: number;
  /** Steps skipped because they were protected holes. */
  protected_segments: number;
};

/**
 * A target is addressable when something durable identifies it. A role alone is
 * not enough: "the third textbox" is a coincidence, not a target, and replaying
 * it is how an agent types into the wrong field after a redesign.
 */
function targetIsStable(step: ObservedAction): boolean {
  const t = step.target;
  return Boolean(t.identifier || t.accessible_name || t.menu_path.length > 0);
}

/** Deterministic step id: same trace ⇒ same ids, so specs are comparable. */
function stepId(trace: LocalActionTrace, step: ObservedAction): string {
  return `${trace.trace_id.slice(0, 8)}-s${step.order}`;
}

/**
 * Compiles one representative trace into an AgentSpec.
 *
 * The caller chooses the representative (the pattern engine knows which
 * occurrence is typical); this function's job is faithful translation and honest
 * refusal.
 */
export function compileTraceToAgentSpec(request: TraceCompileRequest): TraceCompileResult {
  const { trace, availableCapabilities } = request;
  const now = request.now ?? (() => new Date());
  const missing: MissingConfigurationItem[] = [];

  // 1. Dataflow must be sound before anything else: a spec built on a binding
  //    that reads from a later step would deadlock at run time.
  const readiness = traceReadiness(trace);
  if (!readiness.ready) {
    return {
      ok: false,
      missing_configuration: [
        { kind: "target", detail: readiness.problems[0] ?? "unusable trace" },
      ],
      detail: readiness.problems.join("; "),
    };
  }

  // 2. Every app in the trace must be a browser surface, because the browser
  //    lane is the one that is genuinely implemented. A native step is named as
  //    unsupported rather than silently dropped, which would produce an agent
  //    that does part of the user's routine without saying so.
  const nativeStep = trace.steps.find((s) => s.surface !== "browser_dom");
  if (nativeStep) {
    return {
      ok: false,
      missing_configuration: [
        {
          kind: "workflow_definition",
          detail: `step ${nativeStep.order} happened in ${nativeStep.surface}, and only the browser lane can execute today`,
        },
      ],
      detail: `unsupported surface: ${nativeStep.surface}`,
    };
  }

  const origin = trace.steps.find((s) => s.origin)?.origin;
  if (!origin) {
    missing.push({ kind: "origin", detail: "Which site this workflow runs on." });
  }

  const steps: AgentSpec["steps"] = [];
  const inputs: AgentSpec["inputs"] = [];

  for (const step of trace.steps) {
    const mapped = BROWSER_OPERATIONS[step.operation];
    if (!mapped) {
      missing.push({
        kind: "workflow_definition",
        detail: `I watched you ${step.operation.replace(/_/g, " ")}, and I cannot do that yet.`,
      });
      continue;
    }
    if (!availableCapabilities.has(mapped.capability)) {
      missing.push({
        kind: "workflow_definition",
        detail: `${mapped.capability} is not available on this device.`,
      });
      continue;
    }
    if (!targetIsStable(step)) {
      missing.push({
        kind: "target",
        step_id: stepId(trace, step),
        detail: `I could not tell which control step ${step.order} acted on.`,
      });
      continue;
    }

    // 3. Bindings survive translation. A runtime input becomes a declared input
    //    the pet asks about ONCE, inline — the reason a missing value does not
    //    block creation.
    const binding = step.value_binding;
    const stepInputs: AgentSpec["steps"][number]["inputs"] = {};
    if (binding.kind === "runtime_input") {
      if (!inputs.some((i) => i.key === binding.input_id)) {
        inputs.push({
          key: binding.input_id,
          label: binding.prompt,
          type: "string",
          // "user" is the contract's name for a value the person supplies —
          // the inline question, not a stored constant.
          source: "user",
          required: true,
          sensitivity: "internal",
        });
      }
      stepInputs["value"] = { source: "agent_input", ref: binding.input_id };
    } else if (binding.kind === "from_step") {
      // The ref must name the producing step's OUTPUT KEY, not its step_id —
      // the validator resolves step_output references against output_key, and
      // the seeding smoke test caught exactly this mismatch (V-REF-2) after a
      // unit test had only asserted the binding's source.
      stepInputs["value"] = {
        source: "step_output",
        ref: `step_${binding.step}`,
      };
      // The read step's output is an object of every field it read; this names
      // the one this value actually came from. Discovered by shadow-testing:
      // without it the binding validated and then failed at run time.
      stepInputs["value_field"] = { source: "literal", value: binding.output };
    } else if (binding.kind === "local_constant") {
      // The encrypted reference travels; the VALUE stays in the store. Nothing
      // here can decrypt it, so a constant cannot leak into a spec.
      stepInputs["value"] = { source: "literal", value: `encrypted:${binding.encrypted_ref}` };
    }

    // 4. Targets, preconditions and readback are preserved verbatim — they are
    //    the whole reason a trace is worth more than an event.
    stepInputs["target"] = {
      source: "literal",
      value: JSON.stringify({
        role: step.target.role,
        ...(step.target.accessible_name ? { name: step.target.accessible_name } : {}),
        ...(step.target.identifier ? { identifier: step.target.identifier } : {}),
      }),
    };
    if (step.preconditions.expect_current_ref) {
      stepInputs["expect_current"] = {
        source: "literal",
        value: `encrypted:${step.preconditions.expect_current_ref}`,
      };
    }

    steps.push({
      step_id: stepId(trace, step),
      order: steps.length + 1,
      name: describeStep(step),
      capability_id: mapped.capability,
      capability_version: 1,
      mode: mapped.mode,
      inputs: stepInputs,
      output_key: `step_${step.order}`,
      risk_level: mapped.mode === "read" ? "low" : "medium",
      approval: {
        // A consequential action is approval-bound at the SPEC level, so an
        // agent cannot be configured out of asking.
        required: mapped.mode !== "read",
        ...(mapped.mode !== "read" ? { reason: "changes a real record" } : {}),
      },
      retry: { allowed: false, max_attempts: 0, backoff_seconds: [] },
    });
  }

  // 5. Nothing executable ⇒ no agent. An empty spec that registers successfully
  //    is the "decorative agent" failure this whole path exists to avoid.
  if (steps.length === 0) {
    return {
      ok: false,
      missing_configuration:
        missing.length > 0
          ? missing
          : [
              {
                kind: "workflow_definition",
                detail: "nothing in this routine can be executed yet",
              },
            ],
      detail: "no executable steps",
    };
  }
  if (missing.length > 0) {
    return { ok: false, missing_configuration: missing, detail: "incomplete trace" };
  }

  // Built field-by-field against the real schema — no cast. A cast here would
  // have hidden that `source_trace_id`, `compiler` and `compiler_version` did
  // not exist on the contract at all.
  const spec: AgentSpec = {
    schema_version: 1,
    agent_id: uuidv7(),
    version_id: uuidv7(),
    organization_id: request.organization_id,
    owner_user_id: request.owner_user_id,
    name: request.name,
    description: `Compiled from ${steps.length} observed ${steps.length === 1 ? "step" : "steps"}.`,
    generalized_intent: `replay_observed_trace`,
    source_pattern_id: request.pattern_id,
    // Provenance in the spec itself: a reviewer can get from this agent back to
    // the encrypted trace that justifies every step. NOT "demo" — the
    // deterministic on-device compiler has a name, and a spec claiming a fixture
    // or a model produced it would be a lie in the audit trail.
    source_trace_id: trace.trace_id,
    compiler: TRACE_COMPILER_ID,
    compiler_version: TRACE_COMPILER_VERSION,
    state: "shadow",
    trigger: origin
      ? {
          type: "context",
          app_category: "browser",
          origin,
          cooldown_seconds: 300,
        }
      : { type: "manual" },
    inputs,
    steps,
    assertions: [],
    budgets: {
      max_runtime_seconds: 120,
      // Zero, and true: this compiler constructs no model provider, so a spec
      // it produced cannot spend tokens or money.
      max_model_tokens: 0,
      max_cost_usd: 0,
      max_records_read: 100,
      max_records_written: steps.filter((step) => step.mode !== "read").length,
    },
    failure_policy: {
      on_assertion_failure: "stop",
      on_tool_failure: "stop",
      max_safe_retries: 0,
      approval_timeout_minutes: 60,
    },
    created_at: now().toISOString(),
    created_by: "compiler",
  };

  return {
    ok: true,
    spec,
    provenance: {
      pattern_id: request.pattern_id,
      trace_id: trace.trace_id,
      compiler: TRACE_COMPILER_ID,
      compiler_version: TRACE_COMPILER_VERSION,
      compiled_steps: steps.length,
      protected_segments: trace.protected_segments.length,
    },
  };
}

/** Plain language, from the observation — never a recipe's name. */
function describeStep(step: ObservedAction): string {
  const what = step.target.accessible_name ?? step.target.identifier ?? step.target.role;
  switch (step.operation) {
    case "read_field":
      return `Read ${what}`;
    case "set_value":
      return `Set ${what}`;
    case "press":
      return `Press ${what}`;
    case "list_controls":
      return "Find the controls on the page";
    default:
      return `${step.operation} ${what}`;
  }
}
