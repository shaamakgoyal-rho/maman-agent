import { describe, expect, it } from "vitest";
import { uuidv7, type PatternCandidate } from "@maman/contracts";
import { DEFAULT_ORG_POLICY } from "@maman/policy-engine";
import { compileAgentSpec, type CompileRequest } from "../src/compiler.js";
import { demoAdapterRegistry, DemoSalesforceWorld } from "../src/adapters.js";
import {
  requireAdapter,
  runtimeFromRegistry,
  RuntimeCapabilityError,
  validateRuntimeCapabilities,
} from "../src/runtime-capabilities.js";

/**
 * THE UNDEFINED-ADAPTER REGRESSION.
 *
 * The browser workflow recipe emits `browser.propose_form_fill` and
 * `browser.supervised_form_fill`. NO adapter registry in this repository
 * implements either. The desktop run path resolved adapters with
 * `registry.get(step.capability_id)!` — a non-null assertion over a Map.get —
 * so `undefined` was handed to `executeStep`, which dereferenced it: a compiled,
 * user-approved agent crashed with a TypeError on its second step instead of
 * reporting that it could not run.
 */

const LIVE_BROWSER_WRITE = [
  "macos_ax:browser:element_focused:AXGroup:-:-",
  "macos_ax:browser:value_committed:AXTextField:-:-",
];

function candidate(sequence: string[]): PatternCandidate {
  return {
    pattern_id: uuidv7(),
    owner_user_id: uuidv7(),
    first_seen_at: "2026-08-02T23:29:58.543Z",
    last_seen_at: "2026-08-05T18:08:55.617Z",
    occurrence_count: 24,
    distinct_day_count: 4,
    median_duration_ms: 30_000,
    p90_duration_ms: 45_000,
    canonical_sequence: sequence,
    episode_ids: [],
    similarity_mean: 1,
    repeatability_score: 0.9,
    feasibility_score: 1,
    risk_score: 0.38,
    projected_minutes_saved_weekly: 12,
    opportunity_score: 0.69,
    status: "eligible",
  };
}

function request(over: Partial<CompileRequest> = {}): CompileRequest {
  return {
    candidate: candidate(LIVE_BROWSER_WRITE),
    generalized_intent: "automate_record_workflow",
    desired_outcome: "Update text fields in the browser",
    organization_id: uuidv7(),
    owner_user_id: uuidv7(),
    budgets: {
      max_runtime_seconds: 300,
      max_model_tokens: 12_000,
      max_cost_usd: 1,
      max_records_read: 1000,
      max_records_written: 20,
    },
    policy: DEFAULT_ORG_POLICY,
    policy_version_id: uuidv7(),
    now: () => new Date("2026-08-07T06:00:00.000Z"),
    ...over,
  };
}

const localRuntime = () =>
  runtimeFromRegistry("local-demo", demoAdapterRegistry(new DemoSalesforceWorld()));

describe("the local runtime is missing the browser write adapters", () => {
  it("registers NO browser capability at all", () => {
    // The demo registry is the Salesforce world. It used to answer
    // `browser.extract_structured_fields` with DEMO_CSV_ROWS — CSV fixtures
    // presented as fields read from a page — so a browser workflow silently ran
    // on invented data. Real browser capabilities now come only from
    // `browserAdapters()`, which needs a transport and an origin allowlist.
    const runtime = localRuntime();
    for (const id of [
      "browser.extract_structured_fields",
      "browser.extract_table",
      "browser.propose_form_fill",
      "browser.supervised_form_fill",
    ]) {
      expect(runtime.available.has(id), id).toBe(false);
    }
  });
});

describe("a spec is validated against the runtime that will execute it", () => {
  it("reports a missing adapter rather than passing undefined onward", () => {
    const readiness = validateRuntimeCapabilities(
      {
        steps: [
          {
            step_id: "fill",
            order: 1,
            name: "Fill the form",
            capability_id: "browser.supervised_form_fill",
            capability_version: 1,
            mode: "write",
            inputs: {},
            output_key: "out",
            risk_level: "high",
            approval: { required: true },
            retry: { allowed: false, max_attempts: 0, backoff_seconds: [] },
          },
        ],
      },
      localRuntime(),
    );
    expect(readiness.ready).toBe(false);
    expect(readiness.missing[0]!.reason).toBe("no_adapter");
    expect(readiness.missing[0]!.capability_id).toBe("browser.supervised_form_fill");
  });

  it("rejects a write step whose adapter implements only read", () => {
    // An adapter present but lacking write() must not satisfy a write step —
    // that is how a write silently becomes a no-op that still "succeeds".
    const runtime = runtimeFromRegistry(
      "partial",
      new Map([["salesforce.update_fields", { read: () => undefined }]]),
    );
    const readiness = validateRuntimeCapabilities(
      {
        steps: [
          {
            step_id: "w",
            order: 1,
            name: "Update",
            capability_id: "salesforce.update_fields",
            capability_version: 1,
            mode: "write",
            inputs: {},
            output_key: "o",
            risk_level: "medium",
            approval: { required: true },
            retry: { allowed: false, max_attempts: 0, backoff_seconds: [] },
          },
        ],
      },
      runtime,
    );
    expect(readiness.ready).toBe(false);
    expect(readiness.missing[0]!.reason).toBe("mode_unsupported");
  });

  it("reports an unmet connector prerequisite as its own reason", () => {
    const runtime = runtimeFromRegistry(
      "worker-real",
      new Map([["salesforce.query_records", { read: () => undefined }]]),
      new Map([["salesforce.query_records", "Salesforce is not connected"]]),
    );
    const readiness = validateRuntimeCapabilities(
      {
        steps: [
          {
            step_id: "q",
            order: 1,
            name: "Query",
            capability_id: "salesforce.query_records",
            capability_version: 1,
            mode: "read",
            inputs: {},
            output_key: "o",
            risk_level: "low",
            approval: { required: false },
            retry: { allowed: true, max_attempts: 3, backoff_seconds: [1] },
          },
        ],
      },
      runtime,
    );
    expect(readiness.ready).toBe(false);
    expect(readiness.missing[0]!.reason).toBe("prerequisite_unmet");
    expect(readiness.missing[0]!.detail).toBe("Salesforce is not connected");
  });
});

describe("requireAdapter replaces the non-null assertion", () => {
  const step = {
    step_id: "fill",
    order: 1,
    name: "Fill",
    capability_id: "browser.supervised_form_fill",
    capability_version: 1,
    mode: "write" as const,
    inputs: {},
    output_key: "o",
    risk_level: "high" as const,
    approval: { required: true },
    retry: { allowed: false, max_attempts: 0, backoff_seconds: [] },
  };

  it("throws a typed error instead of returning undefined", () => {
    const registry = new Map<string, { write: () => void }>();
    expect(() => requireAdapter(registry, step, "local-demo")).toThrow(RuntimeCapabilityError);
  });

  it("names the capability and the runtime in the error", () => {
    try {
      requireAdapter(new Map(), step, "local-demo");
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as RuntimeCapabilityError;
      expect(err.runtime_id).toBe("local-demo");
      expect(err.missing[0]!.capability_id).toBe("browser.supervised_form_fill");
      expect(err.message).toContain("browser.supervised_form_fill");
    }
  });

  it("returns the adapter when it is present", () => {
    const adapter = { write: () => undefined };
    const registry = new Map([["browser.supervised_form_fill", adapter]]);
    expect(requireAdapter(registry, step, "local-demo")).toBe(adapter);
  });
});

describe("the compiler will not emit steps the runtime cannot execute", () => {
  it("returns needs_runtime for a browser write on the local runtime", async () => {
    const result = await compileAgentSpec(request({ runtime: localRuntime() }));
    expect(result.status).toBe("needs_runtime");
    if (result.status !== "needs_runtime") throw new Error("expected needs_runtime");
    expect(result.missing.map((m) => m.capability_id)).toContain("browser.supervised_form_fill");
    // Distinct from "blocked": the workflow is understood, the runtime is not ready.
    expect(result.message).toBeTruthy();
  });

  it("refuses even a READ-ONLY browser workflow on a runtime with no browser adapter", async () => {
    // Previously this compiled, because the demo registry answered the read with
    // fixtures. Refusing is the honest answer: this runtime cannot read a page.
    const result = await compileAgentSpec(
      request({
        candidate: candidate(["macos_ax:browser:element_focused:AXGroup:-:-"]),
        runtime: localRuntime(),
      }),
    );
    expect(result.status).toBe("needs_runtime");
    if (result.status !== "needs_runtime") return;
    expect(result.missing[0]!.capability_id).toBe("browser.extract_structured_fields");
  });

  it("every compiled step has an adapter on the runtime it compiled for", async () => {
    // The invariant the crash violated: if a spec comes back valid, the runtime
    // it was compiled against can execute all of it.
    const runtime = localRuntime();
    const result = await compileAgentSpec(
      request({
        // The derived update-records intent now needs BOTH halves of the
        // reconciliation evidence: a tabular source and a CRM destination.
        candidate: candidate([
          "chrome:spreadsheet:table_read:grid:account_list:account",
          "chrome:crm:record_updated:field:account_field:account",
        ]),
        generalized_intent: "update_account_records",
        runtime,
      }),
    );
    if (result.status !== "valid") throw new Error(`expected valid, got ${result.status}`);
    expect(validateRuntimeCapabilities(result.spec, runtime).ready).toBe(true);
  });

  it("compiles runtime-blind when no runtime is supplied (backward compatible)", async () => {
    // Existing callers that pass no runtime keep the previous behaviour.
    const result = await compileAgentSpec(request());
    expect(result.status).toBe("valid");
  });
});
