import { describe, expect, it } from "vitest";
import {
  uuidv7,
  learnedWorkflowSchema,
  workflowReadiness,
  type LearnedWorkflow,
} from "@maman/contracts";
import { DEFAULT_ORG_POLICY } from "@maman/policy-engine";
import { compileLearnedWorkflow } from "../src/compile-learned.js";
import { browserAdapters } from "../src/browser-adapters.js";
import { runtimeFromRegistry } from "../src/runtime-capabilities.js";
import type { OwnWindowHost } from "@maman/browser-actuator";

/**
 * Compiling a workflow the USER configured.
 *
 * The inference path had to decide what an observed sequence meant, and every
 * decision could be wrong in a way the user would not notice until a write
 * landed somewhere unexpected. This path starts from stated targets, values and
 * success conditions, so it TRANSLATES rather than guesses — and refuses, by
 * type, when the record is incomplete.
 */

const ORIGIN = "https://acme.example";
const PATTERN = "019fc4d0-130f-706e-b94e-42a86e9b3812";
const OWNER = "019fc4d0-130f-706e-b94e-42a86e9b3815";

function workflow(over: Partial<LearnedWorkflow> = {}): LearnedWorkflow {
  return learnedWorkflowSchema.parse({
    schema_version: 1,
    workflow_id: uuidv7(),
    version: 1,
    source_pattern_id: PATTERN,
    owner_user_id: OWNER,
    name: "Update the phone on a contact",
    trigger: { type: "manual" },
    allowed_origins: [ORIGIN],
    steps: [
      {
        step_id: "read-phone",
        order: 1,
        description: "Read the current phone number",
        capability_id: "browser.extract_structured_fields",
        mode: "read",
        target: { role: "textbox", name: "Phone" },
        success: { kind: "none" },
      },
      {
        step_id: "fill-phone",
        order: 2,
        description: "Type the new phone number",
        capability_id: "browser.supervised_form_fill",
        mode: "write",
        target: { role: "textbox", name: "Phone" },
        value: { kind: "prompt", label: "New phone number", required: true },
        success: { kind: "readback_equals" },
      },
    ],
    missing_configuration: [],
    provenance: "user_configured",
    created_at: "2026-08-07T10:00:00.000Z",
    updated_at: "2026-08-07T10:00:00.000Z",
    ...over,
  });
}

function request(w: LearnedWorkflow, runtime?: ReturnType<typeof runtimeFromRegistry>) {
  return {
    workflow: w,
    organization_id: "019fc4d0-130f-706e-b94e-42a86e9b3814",
    owner_user_id: OWNER,
    budgets: {
      max_runtime_seconds: 300,
      max_model_tokens: 12_000,
      max_cost_usd: 1,
      max_records_read: 1000,
      max_records_written: 20,
    },
    policy: DEFAULT_ORG_POLICY,
    policy_version_id: uuidv7(),
    now: () => new Date("2026-08-07T12:00:00.000Z"),
    ...(runtime ? { runtime } : {}),
  };
}

const host: OwnWindowHost = {
  currentOrigin: async () => ORIGIN,
  navigate: async () => undefined,
  evaluate: async () => "{}",
};
const browserRuntime = () =>
  runtimeFromRegistry(
    "local",
    browserAdapters({
      host,
      allowedOrigins: [ORIGIN],
      userPresent: () => true,
      allowSupervisedBrowserWrites: true,
      newRequestId: () => uuidv7(),
      mintAuthorization: () => "z".repeat(43),
    }),
  );

describe("a configured workflow compiles to exactly what was configured", () => {
  it("produces one spec step per configured step, in order", () => {
    const result = compileLearnedWorkflow(request(workflow()));
    expect(result.status).toBe("valid");
    if (result.status !== "valid") return;
    expect(result.spec.steps.map((s) => [s.step_id, s.capability_id, s.mode])).toEqual([
      ["read-phone", "browser.extract_structured_fields", "read"],
      ["fill-phone", "browser.supervised_form_fill", "write"],
    ]);
  });

  it("keeps the write approval-gated — configuring is not approving", () => {
    // The user configuring a workflow and the user approving a specific run's
    // changes are different acts, and only the second authorises a write.
    const result = compileLearnedWorkflow(request(workflow()));
    if (result.status !== "valid") throw new Error("expected valid");
    const write = result.spec.steps.find((s) => s.mode === "write")!;
    expect(write.approval.required).toBe(true);
  });

  it("turns a prompt into a REQUIRED agent input the run must collect", () => {
    const result = compileLearnedWorkflow(request(workflow()));
    if (result.status !== "valid") throw new Error("expected valid");
    expect(result.spec.inputs).toContainEqual(
      expect.objectContaining({
        key: "fill-phone_value",
        label: "New phone number",
        required: true,
      }),
    );
  });

  it("records the audit trail from pattern to workflow version to spec", () => {
    const w = workflow({ version: 3 });
    const result = compileLearnedWorkflow(request(w));
    if (result.status !== "valid") throw new Error("expected valid");
    expect(result.compiled_from).toEqual({
      pattern_id: PATTERN,
      workflow_id: w.workflow_id,
      workflow_version: 3,
      recipe: "learned-workflow",
    });
    expect(result.spec.source_pattern_id).toBe(PATTERN);
  });

  it("never invents an input the user did not configure", () => {
    // The inference path's tell was a required `account_csv` from nowhere.
    const result = compileLearnedWorkflow(request(workflow()));
    if (result.status !== "valid") throw new Error("expected valid");
    expect(result.spec.inputs.map((i) => i.key)).toEqual(["fill-phone_value"]);
  });
});

describe("incomplete configuration is refused, by type", () => {
  it("refuses a workflow with no origin — there is nowhere it may act", () => {
    const result = compileLearnedWorkflow(request(workflow({ allowed_origins: [] })));
    expect(result.status).toBe("needs_configuration");
  });

  it("refuses a workflow with no steps", () => {
    const result = compileLearnedWorkflow(request(workflow({ steps: [] })));
    expect(result.status).toBe("needs_configuration");
  });

  it("refuses a browser step that does not say which field it acts on", () => {
    const w = workflow();
    // Strip the target the way an unfinished teach session would leave it.
    const broken = { ...w, steps: [{ ...w.steps[0]!, target: undefined }, w.steps[1]!] };
    const readiness = workflowReadiness(broken as LearnedWorkflow);
    expect(readiness.ready).toBe(false);
    expect(readiness.missing.some((m) => m.kind === "target")).toBe(true);
  });

  it("carries an explicit missing_configuration entry straight through", () => {
    const result = compileLearnedWorkflow(
      request(
        workflow({
          missing_configuration: [
            { kind: "data_source", detail: "Where does the new phone number come from?" },
          ],
        }),
      ),
    );
    expect(result.status).toBe("needs_configuration");
    if (result.status !== "needs_configuration") return;
    expect(result.message).toMatch(/Where does the new phone number come from/);
  });

  it("refuses a step whose value comes from a step that does not run before it", () => {
    // A forward or self reference is unsatisfiable at run time.
    const w = workflow();
    const broken = {
      ...w,
      steps: [
        w.steps[0]!,
        {
          ...w.steps[1]!,
          value: { kind: "step_output" as const, step_id: "a-later-step", path: "value" },
        },
      ],
    };
    expect(workflowReadiness(broken as LearnedWorkflow).ready).toBe(false);
  });
});

describe("the same bars as the inference path", () => {
  it("refuses a capability that is not in the catalog", () => {
    const w = workflow();
    const result = compileLearnedWorkflow(
      request({
        ...w,
        steps: [{ ...w.steps[0]!, capability_id: "evil.delete_everything" }],
      } as LearnedWorkflow),
    );
    expect(result.status).toBe("blocked");
  });

  it("refuses when the runtime cannot execute a configured step", () => {
    const emptyRuntime = runtimeFromRegistry("bare", new Map());
    const result = compileLearnedWorkflow(request(workflow(), emptyRuntime));
    expect(result.status).toBe("needs_runtime");
    if (result.status !== "needs_runtime") return;
    expect(result.missing).toContain("browser.supervised_form_fill");
  });

  it("compiles against a runtime that DOES have the browser adapters", () => {
    const result = compileLearnedWorkflow(request(workflow(), browserRuntime()));
    expect(result.status).toBe("valid");
  });
});

describe("secrets are references, never values", () => {
  it("rejects a credential-shaped constant at the schema boundary", () => {
    expect(() =>
      workflow({
        steps: [
          {
            step_id: "fill",
            order: 1,
            description: "Type the token",
            capability_id: "browser.supervised_form_fill",
            mode: "write",
            target: { role: "textbox", name: "Token" },
            // A real-looking credential must not be storable as a constant.
            value: { kind: "constant", value: "sk_live_51H8xQ2eZvKYlo2C0aBcDeFgHiJkLmNoP" },
            success: { kind: "readback_equals" },
          },
        ],
      } as never),
    ).toThrow();
  });

  it("compiles a secret_ref into a confidential input, not a literal", () => {
    const w = workflow({
      steps: [
        {
          step_id: "fill-token",
          order: 1,
          description: "Fill the stored value",
          capability_id: "browser.supervised_form_fill",
          mode: "write",
          target: { role: "textbox", name: "Token" },
          value: { kind: "secret_ref", ref: "keychain://maman/acme-token" },
          success: { kind: "readback_equals" },
        },
      ],
    } as never);
    const result = compileLearnedWorkflow(request(w));
    if (result.status !== "valid") throw new Error(`expected valid, got ${result.status}`);
    const input = result.spec.inputs.find((i) => i.key === "fill-token_secret")!;
    expect(input.sensitivity).toBe("confidential");
    // The reference itself is not embedded as a literal anywhere in the spec.
    expect(JSON.stringify(result.spec)).not.toContain("keychain://maman/acme-token");
  });
});

describe("a write must be checkable", () => {
  it("rejects a write whose success condition is 'none'", () => {
    expect(() =>
      workflow({
        steps: [
          {
            step_id: "fill",
            order: 1,
            description: "Type something",
            capability_id: "browser.supervised_form_fill",
            mode: "write",
            target: { role: "textbox", name: "Phone" },
            value: { kind: "constant", value: "x" },
            success: { kind: "none" },
          },
        ],
      } as never),
    ).toThrow();
  });

  it("rejects a write with no value source", () => {
    expect(() =>
      workflow({
        steps: [
          {
            step_id: "fill",
            order: 1,
            description: "Type nothing",
            capability_id: "browser.supervised_form_fill",
            mode: "write",
            target: { role: "textbox", name: "Phone" },
            success: { kind: "readback_equals" },
          },
        ],
      } as never),
    ).toThrow();
  });
});

describe("an unimplemented trigger is recorded, never silently honoured", () => {
  it("compiles as manual and SAYS the trigger does not run yet", () => {
    const result = compileLearnedWorkflow(
      request(
        workflow({
          trigger: { type: "workflow_start", pattern_signature: "sig-123" },
        }),
      ),
    );
    if (result.status !== "valid") throw new Error("expected valid");
    expect(result.spec.trigger.type).toBe("manual");
    expect(result.warnings.some((w) => /nothing runs it yet/.test(w))).toBe(true);
  });
});
