import { describe, expect, it } from "vitest";
import { uuidv7, type AgentSpec } from "@maman/contracts";
import { DEFAULT_ORG_POLICY } from "@maman/policy-engine";
import {
  AgentInputError,
  describeMissingInputs,
  validateAgentInputs,
} from "../src/agent-inputs.js";
import { compileAgentSpec, type CompileRequest } from "../src/compiler.js";
import {
  demoAdapterRegistry,
  DemoSalesforceWorld,
  DEMO_ACCOUNT_LIST,
  PermanentAdapterError,
} from "../src/adapters.js";
import { executeStep, resolveStepInputs } from "../src/run-engine.js";
import type { CapabilityContext } from "../src/adapters.js";

/**
 * A DECLARED REQUIREMENT THAT NOTHING ENFORCED.
 *
 * The reconciliation spec declares `account_csv` required and user-supplied.
 * The desktop passed `agentInputs: {}`. `resolveStepInputs` bound `undefined`
 * without complaint, and `local.parse_csv` was `read: async () =>
 * structuredClone(DEMO_CSV_ROWS)` — it took no parameters at all. So the run
 * reconciled FIXTURE ROWS end to end, produced a diff, and published a receipt
 * with ROI for an account list nobody had ever provided.
 *
 * Ten tests in this package passed against that path, which is how it survived.
 */

const RUN: CapabilityContext = {
  run_id: uuidv7(),
  organization_id: uuidv7(),
  owner_user_id: uuidv7(),
  mode: "shadow",
};

function specWith(inputs: AgentSpec["inputs"]): AgentSpec {
  return {
    schema_version: 1,
    agent_id: uuidv7(),
    version_id: uuidv7(),
    organization_id: uuidv7(),
    owner_user_id: uuidv7(),
    name: "test",
    description: "test",
    generalized_intent: "test",
    source_pattern_id: uuidv7(),
    state: "draft",
    trigger: { type: "manual" },
    inputs,
    steps: [],
    assertions: [],
    budgets: {
      max_runtime_seconds: 60,
      max_model_tokens: 0,
      max_cost_usd: 0,
      max_records_read: 10,
      max_records_written: 1,
    },
    failure_policy: {
      on_assertion_failure: "stop",
      on_tool_failure: "stop",
      max_safe_retries: 0,
      approval_timeout_minutes: 60,
    },
    created_at: new Date("2026-08-09T00:00:00.000Z").toISOString(),
    created_by: "compiler",
  };
}

const required = (key: string, source: AgentSpec["inputs"][number]["source"] = "user") =>
  ({
    key,
    label: `The ${key}`,
    type: "string" as const,
    required: true,
    sensitivity: "internal" as const,
    source,
  }) satisfies AgentSpec["inputs"][number];

describe("a run refuses when its own spec is unsatisfied", () => {
  it("reports a required input nobody supplied", () => {
    const readiness = validateAgentInputs(specWith([required("account_csv")]), {});
    expect(readiness.ready).toBe(false);
    if (readiness.ready) throw new Error("unreachable");
    expect(readiness.missing).toEqual([
      { key: "account_csv", label: "The account_csv", source: "user", reason: "not_supplied" },
    ]);
  });

  it("treats an empty string and an empty array as MISSING, not as an answer", () => {
    // An empty array is exactly what the browser read adapter received when
    // discovery had not run, and calling that "supplied" is what let the run
    // continue as far as throwing.
    const spec = specWith([required("fields")]);
    expect(validateAgentInputs(spec, { fields: [] }).ready).toBe(false);
    expect(validateAgentInputs(spec, { fields: "  " }).ready).toBe(false);
    expect(validateAgentInputs(spec, { fields: null }).ready).toBe(false);
    expect(validateAgentInputs(spec, { fields: ["Phone"] }).ready).toBe(true);
  });

  it("leaves optional inputs alone — absent is their correct value", () => {
    const spec = specWith([{ ...required("note"), required: false }]);
    expect(validateAgentInputs(spec, {}).ready).toBe(true);
  });

  it("says who is supposed to supply the thing", () => {
    // "You need to give me X" and "I should have found X by looking" are
    // different problems, and only one of them is the user's to fix.
    const mixed = specWith([required("account_csv"), required("fields", "discovered_on_surface")]);
    const readiness = validateAgentInputs(mixed, {});
    if (readiness.ready) throw new Error("expected missing");
    const message = describeMissingInputs(readiness.missing);
    expect(message).toContain("I still need from you: The account_csv");
    expect(message).toContain("could not work out The fields by looking");
  });

  it("carries the missing list on the error, not just a sentence", () => {
    const readiness = validateAgentInputs(specWith([required("account_csv")]), {});
    if (readiness.ready) throw new Error("expected missing");
    const error = new AgentInputError(readiness);
    expect(error).toBeInstanceOf(Error);
    expect(error.missing.map((m) => m.key)).toEqual(["account_csv"]);
  });
});

describe("the backstop inside step resolution", () => {
  const spec = specWith([required("account_csv")]);
  const step = {
    step_id: "parse-csv",
    order: 1,
    name: "Parse",
    capability_id: "local.parse_csv",
    capability_version: 1,
    mode: "read" as const,
    inputs: { file: { source: "agent_input" as const, ref: "account_csv" } },
    output_key: "rows",
    risk_level: "low" as const,
    approval: { required: false },
    retry: { allowed: false, max_attempts: 0, backoff_seconds: [] },
  };

  it("REFUSES to bind undefined where a required value was declared", () => {
    // The old behaviour was `resolved[name] = agentInputs[binding.ref]` with the
    // spec explicitly ignored (`void spec`), so this returned `{file: undefined}`
    // and the step ran.
    expect(() => resolveStepInputs(step, spec, { outputs: {} }, {})).toThrow(/was not supplied/);
  });

  it("binds an optional input's absence without complaint", () => {
    const optional = specWith([{ ...required("account_csv"), required: false }]);
    expect(resolveStepInputs(step, optional, { outputs: {} }, {})).toEqual({ file: undefined });
  });
});

describe("the demo adapter no longer answers for data it was not given", () => {
  const world = () => new DemoSalesforceWorld();

  it("serves the bundled sample ONLY when asked for it by name", async () => {
    const registry = demoAdapterRegistry(world());
    const rows = await registry.get("local.parse_csv")!.read!({ file: DEMO_ACCOUNT_LIST }, RUN);
    expect(Array.isArray(rows)).toBe(true);
    expect((rows as unknown[]).length).toBeGreaterThan(0);
  });

  it("refuses a real file path rather than quietly returning fixtures", async () => {
    // This is the "no real execution path falls back to fixtures" rule. A user
    // who supplied their own list must not be shown sample results.
    const registry = demoAdapterRegistry(world());
    await expect(
      registry.get("local.parse_csv")!.read!({ file: "/Users/me/accounts.csv" }, RUN),
    ).rejects.toThrow(PermanentAdapterError);
  });

  it("refuses an unbound input rather than inventing a list", async () => {
    const registry = demoAdapterRegistry(world());
    await expect(registry.get("local.parse_csv")!.read!({}, RUN)).rejects.toThrow(
      /will not invent one/,
    );
  });
});

describe("end to end: the reconciliation agent cannot run on data nobody gave it", () => {
  async function reconciliationSpec(): Promise<AgentSpec> {
    const request: CompileRequest = {
      candidate: {
        pattern_id: uuidv7(),
        owner_user_id: uuidv7(),
        first_seen_at: "2026-08-01T09:00:00.000Z",
        last_seen_at: "2026-08-02T09:00:00.000Z",
        occurrence_count: 6,
        distinct_day_count: 3,
        median_duration_ms: 180_000,
        p90_duration_ms: 220_000,
        canonical_sequence: ["chrome:crm:record_opened:row:account:account"],
        episode_ids: [],
        similarity_mean: 0.95,
        repeatability_score: 0.9,
        feasibility_score: 0.8,
        risk_score: 0.3,
        projected_minutes_saved_weekly: 40,
        opportunity_score: 0.7,
        status: "eligible",
      },
      generalized_intent: "reconcile_account_list",
      desired_outcome: "Reconcile the account list with Salesforce.",
      organization_id: uuidv7(),
      owner_user_id: uuidv7(),
      budgets: {
        max_runtime_seconds: 300,
        max_model_tokens: 0,
        max_cost_usd: 1,
        max_records_read: 1000,
        max_records_written: 20,
      },
      policy: DEFAULT_ORG_POLICY,
      policy_version_id: uuidv7(),
      now: () => new Date("2026-08-09T00:00:00.000Z"),
    };
    const result = await compileAgentSpec(request);
    if (result.status !== "valid") throw new Error(`expected valid, got ${result.status}`);
    return result.spec;
  }

  it("declares the account list required — the requirement was always there", async () => {
    const spec = await reconciliationSpec();
    expect(spec.inputs.find((i) => i.key === "account_csv")).toMatchObject({
      required: true,
      source: "user",
    });
  });

  it("STOPS before step one when nothing supplied it", async () => {
    const spec = await reconciliationSpec();
    const readiness = validateAgentInputs(spec, {});
    expect(readiness.ready).toBe(false);

    // And if a caller skipped the gate, the step itself refuses rather than
    // reconciling sample rows.
    const registry = demoAdapterRegistry(new DemoSalesforceWorld());
    const first = spec.steps[0]!;
    await expect(
      executeStep({
        spec,
        step: first,
        state: { outputs: {} },
        agentInputs: {},
        ctx: RUN,
        adapter: registry.get(first.capability_id)!,
      }),
    ).rejects.toThrow(/was not supplied/);
  });

  it("runs once the sample list is chosen explicitly", async () => {
    const spec = await reconciliationSpec();
    const inputs = { account_csv: DEMO_ACCOUNT_LIST };
    expect(validateAgentInputs(spec, inputs).ready).toBe(true);

    const registry = demoAdapterRegistry(new DemoSalesforceWorld());
    const first = spec.steps[0]!;
    const result = await executeStep({
      spec,
      step: first,
      state: { outputs: {} },
      agentInputs: inputs,
      ctx: RUN,
      adapter: registry.get(first.capability_id)!,
    });
    expect(result.kind).toBe("read");
    // The choice is recorded in the run's inputs, so a receipt can say which
    // list produced the numbers.
    expect(inputs.account_csv).toBe(DEMO_ACCOUNT_LIST);
  });
});
