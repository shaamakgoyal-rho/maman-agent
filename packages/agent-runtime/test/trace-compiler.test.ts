import { beforeAll, describe, expect, it } from "vitest";
import type { LocalActionTrace } from "@maman/contracts";
import { compileTraceToAgentSpec, TRACE_COMPILER_ID, validateAgentSpec } from "../src/index.js";

/**
 * THE ARROW THAT WAS DISCONNECTED.
 *
 * Traces were captured, encrypted, stored — and read by nothing; compilation went
 * through recipe matching instead ("Salesforce reconciliation" or "generic
 * browser workflow"). These tests pin the replacement: an AgentSpec whose every
 * step came from an observed action, with no model, no fixture, and honest
 * refusal when the evidence is not enough.
 */

// Every hosted key removed before the module under test can see one.
beforeAll(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GROQ_API_KEY;
});

const CONSTANT_REF = "018f0000-0000-7000-8000-00000000a1c1";

const CAPABILITIES = new Set([
  "browser.extract_structured_fields",
  "browser.propose_form_fill",
  "browser.press_control",
]);

function trace(overrides: Partial<LocalActionTrace> = {}): LocalActionTrace {
  return {
    schema_version: 1,
    trace_id: "018f0000-0000-7000-8000-00000000a1aa",
    started_at: "2026-08-10T09:00:00.000Z",
    ended_at: "2026-08-10T09:02:00.000Z",
    apps: [{ category: "browser", origin: "https://leads.example" }],
    steps: [
      {
        order: 1,
        surface: "browser_dom",
        origin: "https://leads.example",
        path_template: "/leads/:id",
        operation: "read_field",
        target: { role: "textbox", accessible_name: "Company", ancestry: [], menu_path: [] },
        value_binding: { kind: "none" },
        preconditions: { requires_foreground: false, requires_user_presence: false },
      },
      {
        order: 2,
        surface: "browser_dom",
        origin: "https://leads.example",
        operation: "press",
        target: { role: "button", accessible_name: "Assign to me", ancestry: [], menu_path: [] },
        value_binding: { kind: "none" },
        preconditions: { requires_foreground: true, requires_user_presence: true },
        expected_effect: { kind: "record_updated", readback: "reread_target" },
      },
    ],
    protected_segments: [],
    pattern_event_refs: [],
    local_only: true,
    ...overrides,
  };
}

function compile(t: LocalActionTrace = trace()) {
  return compileTraceToAgentSpec({
    trace: t,
    pattern_id: "018f0000-0000-7000-8000-00000000a1f1",
    owner_user_id: "018f0000-0000-7000-8000-00000000a1f2",
    organization_id: "018f0000-0000-7000-8000-00000000a1f3",
    name: "Assign and qualify the next lead",
    availableCapabilities: CAPABILITIES,
    now: () => new Date("2026-08-10T10:00:00.000Z"),
  });
}

describe("an observed trace becomes an executable spec", () => {
  it("compiles with every hosted-model key unset, and the spec validates", () => {
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    const result = compile();
    if (!result.ok) throw new Error(`expected a spec: ${result.detail}`);

    // The strongest available check: the runtime's own validator accepts it.
    const validation = validateAgentSpec(result.spec);
    expect(validation.valid, JSON.stringify(validation)).toBe(true);
    expect(result.spec.steps).toHaveLength(2);
    expect(result.spec.name).toBe("Assign and qualify the next lead");
  });

  it("keeps the target, origin, mode and approval policy of what was watched", () => {
    const result = compile();
    if (!result.ok) throw new Error(result.detail);
    const [read, press] = result.spec.steps;

    expect(read!.mode).toBe("read");
    expect(read!.approval.required).toBe(false);
    // A consequential step is approval-bound in the SPEC, so an agent cannot be
    // configured out of asking.
    expect(press!.mode).toBe("propose_write");
    expect(press!.approval.required).toBe(true);
    const targetBinding = press!.inputs["target"]!;
    if (targetBinding.source !== "literal") throw new Error("target must be a literal");
    expect(JSON.parse(String(targetBinding.value))).toMatchObject({
      role: "button",
      name: "Assign to me",
    });
    expect(result.spec.trigger).toMatchObject({
      type: "context",
      app_category: "browser",
      origin: "https://leads.example",
    });
  });

  it("records pattern → trace → spec provenance and an honest compiler identity", () => {
    const result = compile();
    if (!result.ok) throw new Error(result.detail);
    expect(result.spec.source_trace_id).toBe("018f0000-0000-7000-8000-00000000a1aa");
    expect(result.spec.source_pattern_id).toBe("018f0000-0000-7000-8000-00000000a1f1");
    // Not "demo": a spec claiming a fixture or a model made it would be a lie in
    // the audit trail.
    expect(result.spec.compiler).toBe("deterministic-local");
    expect(TRACE_COMPILER_ID).toBe("deterministic-local");
    expect(result.provenance).toMatchObject({ compiled_steps: 2, protected_segments: 0 });
  });

  it("declares zero token and cost budget, because no model is constructed", () => {
    const result = compile();
    if (!result.ok) throw new Error(result.detail);
    expect(result.spec.budgets.max_model_tokens).toBe(0);
    expect(result.spec.budgets.max_cost_usd).toBe(0);
  });

  it("is deterministic: the same trace yields the same steps and ids", () => {
    const a = compile();
    const b = compile();
    if (!a.ok || !b.ok) throw new Error("expected two specs");
    expect(a.spec.steps).toEqual(b.spec.steps);
    expect(a.spec.inputs).toEqual(b.spec.inputs);
  });

  it("NEVER substitutes an unrelated recipe", () => {
    const result = compile();
    if (!result.ok) throw new Error(result.detail);
    const serialized = JSON.stringify(result.spec).toLowerCase();
    // The old failure mode: a browser routine compiled into Salesforce/CSV
    // reconciliation because it matched a recipe.
    for (const foreign of ["salesforce", "reconcil", "parse_csv", "csv"]) {
      expect(serialized, `${foreign} leaked into a spec compiled from a trace`).not.toContain(
        foreign,
      );
    }
  });
});

describe("a missing fact becomes one question, not a form", () => {
  it("turns an unknowable value into a declared runtime input", () => {
    const t = trace();
    t.steps[1] = {
      ...t.steps[1]!,
      operation: "set_value",
      target: { role: "textbox", accessible_name: "Owner", ancestry: [], menu_path: [] },
      value_binding: { kind: "runtime_input", input_id: "owner", prompt: "Who should own it?" },
    };
    const result = compile(t);
    if (!result.ok) throw new Error(result.detail);
    expect(result.spec.inputs).toHaveLength(1);
    expect(result.spec.inputs[0]).toMatchObject({
      key: "owner",
      label: "Who should own it?",
      source: "user",
      required: true,
    });
    expect(result.spec.steps[1]!.inputs["value"]).toEqual({
      source: "agent_input",
      ref: "owner",
    });
  });

  it("carries a dataflow edge as a step-output reference", () => {
    const t = trace();
    t.steps[1] = {
      ...t.steps[1]!,
      operation: "set_value",
      target: { role: "textbox", accessible_name: "Website", ancestry: [], menu_path: [] },
      value_binding: { kind: "from_step", step: 1, output: "Company" },
    };
    const result = compile(t);
    if (!result.ok) throw new Error(result.detail);
    // Not just the source — the REF must resolve to the producing step's
    // output_key, and the whole spec must pass the validator. The weaker
    // assertion here let a V-REF-2 mismatch reach main.
    expect(result.spec.steps[1]!.inputs["value"]).toEqual({
      source: "step_output",
      ref: "step_1",
    });
    // …and the selector that picks the scalar out of the read step's output.
    expect(result.spec.steps[1]!.inputs["value_field"]).toEqual({
      source: "literal",
      value: "Company",
    });
    const validation = validateAgentSpec(result.spec);
    expect(validation.valid, JSON.stringify(validation)).toBe(true);
  });

  it("never inlines an encrypted constant's value", () => {
    const t = trace();
    t.steps[1] = {
      ...t.steps[1]!,
      operation: "set_value",
      value_binding: { kind: "local_constant", encrypted_ref: CONSTANT_REF },
    };
    const result = compile(t);
    if (!result.ok) throw new Error(result.detail);
    // A handle, not a value — nothing here can decrypt it.
    const constantBinding = result.spec.steps[1]!.inputs["value"]!;
    if (constantBinding.source !== "literal") throw new Error("constant must be a literal");
    expect(constantBinding.value).toBe(`encrypted:${CONSTANT_REF}`);
  });
});

describe("it refuses rather than guessing", () => {
  it("refuses an operation it cannot execute, by name", () => {
    const t = trace();
    t.steps[1] = { ...t.steps[1]!, operation: "drag_and_drop" };
    const result = compile(t);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.missing_configuration[0]!.detail).toContain("drag and drop");
  });

  it("refuses a target nothing durable identifies", () => {
    const t = trace();
    // Role only: "the third textbox" is a coincidence, not a target.
    t.steps[1] = {
      ...t.steps[1]!,
      target: { role: "button", ancestry: [], menu_path: [] },
    };
    const result = compile(t);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.missing_configuration[0]!.kind).toBe("target");
  });

  it("refuses a native step instead of silently doing half the routine", () => {
    const t = trace();
    t.steps[1] = { ...t.steps[1]!, surface: "macos_ax" };
    const result = compile(t);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.detail).toContain("macos_ax");
  });

  it("refuses when a capability is not available on this device", () => {
    const result = compileTraceToAgentSpec({
      trace: trace(),
      pattern_id: "018f0000-0000-7000-8000-00000000a1f1",
      owner_user_id: "018f0000-0000-7000-8000-00000000a1f2",
      organization_id: "018f0000-0000-7000-8000-00000000a1f3",
      name: "x",
      availableCapabilities: new Set(), // Browser Relay not connected
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.missing_configuration[0]!.detail).toContain("not available");
  });

  it("refuses a trace whose dataflow reads from a later step", () => {
    const t = trace();
    t.steps[0] = {
      ...t.steps[0]!,
      value_binding: { kind: "from_step", step: 2, output: "x" },
    };
    expect(compile(t).ok).toBe(false);
  });
});
