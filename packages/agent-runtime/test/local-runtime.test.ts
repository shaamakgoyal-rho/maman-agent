import { beforeEach, describe, expect, it } from "vitest";
import { uuidv7, type LearnedWorkflow, type WorkflowContext } from "@maman/contracts";
import type { OwnWindowHost } from "@maman/browser-actuator";
import { DEFAULT_ORG_POLICY } from "@maman/policy-engine";
import { browserAdapters } from "../src/browser-adapters.js";
import { compileLearnedWorkflow } from "../src/compile-learned.js";
import { LocalAgentRuntime, type RegisteredAgent } from "../src/local-runtime.js";
import type { CapabilityContext } from "../src/adapters.js";

/**
 * THE ARROWS CREATE AGENT WAS MISSING, each one exercised for real:
 *
 *   LearnedWorkflow → AgentSpec → runtime validation → registration
 *     → trigger installation → shadow execution → proactive firing → restart
 *
 * And the constraint that governs all of it: NO CLOUD KEY ANYWHERE. The
 * compiler here is `compileLearnedWorkflow`, which has no model field at all;
 * the registry is the browser adapters over a page host; the runtime holds a
 * map. Every cloud env var is deleted before the suite runs, so if anything on
 * this path reached for one it would throw, not silently degrade.
 */

delete process.env.OPENAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.GROQ_API_KEY;

const ORIGIN = "https://acme.example";
const OWNER = "019fc4d0-130f-706e-b94e-42a86e9b3815";
const RUN: Omit<CapabilityContext, "mode"> = {
  run_id: "019fc4d0-130f-706e-b94e-42a86e9b3812",
  organization_id: "019fc4d0-130f-706e-b94e-42a86e9b3814",
  owner_user_id: OWNER,
};

/** A page with a Phone field, answering through the real in-page protocol. */
function page(fields: Record<string, string>) {
  const values = new Map(Object.entries(fields));
  const host: OwnWindowHost = {
    currentOrigin: async () => ORIGIN,
    navigate: async () => undefined,
    evaluate: async (expression: string) => {
      const marker = "})(";
      const literal = expression.slice(expression.lastIndexOf(marker) + marker.length, -1);
      const { request_id, action } = JSON.parse(JSON.parse(literal) as string) as {
        request_id: string;
        action: { kind: string; target?: { name: string }; value?: string };
      };
      const name = action.target?.name ?? "";
      if (action.kind === "read_field" && values.has(name)) {
        return JSON.stringify({
          request_id,
          outcome: "observed",
          observed: { value_after: values.get(name), accessible_name: name, match_count: 1 },
        });
      }
      return JSON.stringify({ request_id, outcome: "refused", refusal_reason: "target_not_found" });
    },
  };
  return host;
}

/** The registry the runtime executes with. Browser adapters ONLY — no demo. */
function realRegistry(host: OwnWindowHost) {
  return browserAdapters({
    host,
    allowedOrigins: [ORIGIN],
    userPresent: () => true,
    allowSupervisedBrowserWrites: true,
    newRequestId: () => uuidv7(),
    mintAuthorization: () => "z".repeat(43),
  });
}

/** A FULLY CONFIGURED learned workflow: origin, target, constant value. */
function taughtWorkflow(): LearnedWorkflow {
  const at = "2026-08-09T12:00:00.000Z";
  return {
    schema_version: 1,
    workflow_id: uuidv7(),
    version: 2,
    source_pattern_id: uuidv7(),
    owner_user_id: OWNER,
    name: "Update the phone on the open record",
    trigger: { type: "workflow_start", pattern_signature: "sig-1" },
    allowed_origins: [ORIGIN],
    steps: [
      {
        step_id: "step-1",
        order: 1,
        description: "Propose the new phone number",
        capability_id: "browser.propose_form_fill",
        mode: "propose_write",
        target: { role: "textbox", name: "Phone" },
        value: { kind: "constant", value: "555-0199" },
        success: { kind: "readback_equals" },
      },
    ],
    missing_configuration: [],
    provenance: "user_configured",
    created_at: at,
    updated_at: at,
  };
}

function compiled(trigger_context?: { app_category: string; origin?: string }) {
  const result = compileLearnedWorkflow({
    workflow: taughtWorkflow(),
    organization_id: RUN.organization_id,
    owner_user_id: OWNER,
    budgets: {
      max_runtime_seconds: 300,
      max_model_tokens: 0,
      max_cost_usd: 0,
      max_records_read: 100,
      max_records_written: 5,
    },
    policy: DEFAULT_ORG_POLICY,
    policy_version_id: uuidv7(),
    now: () => new Date("2026-08-09T12:05:00.000Z"),
    ...(trigger_context ? { trigger_context } : {}),
  });
  if (result.status !== "valid") throw new Error(`expected valid, got ${result.status}`);
  return result.spec;
}

function context(over: Partial<WorkflowContext> = {}): WorkflowContext {
  return {
    source: "chrome_ext",
    app_category: "browser",
    event_type: "element_focused",
    target_role: "textbox",
    semantic_type: "phone",
    object_type: "contact",
    domain: "acme.example",
    occurred_at: "2026-08-09T12:10:00.000Z",
    ...over,
  };
}

let clock = Date.parse("2026-08-09T12:10:00.000Z");
beforeEach(() => {
  clock = Date.parse("2026-08-09T12:10:00.000Z");
});
const now = () => new Date(clock);

describe("no cloud key is needed anywhere on this path", () => {
  it("compiles, registers, and shadow-runs with every cloud env var deleted", async () => {
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();

    const spec = compiled({ app_category: "browser", origin: ORIGIN });
    const runtime = new LocalAgentRuntime({
      registry: realRegistry(page({ Phone: "555-0100" })),
      runtime_id: "local-real",
      now,
    });

    const registered = runtime.registerAgent(spec);
    expect(registered).toEqual({ ok: true, agent_id: spec.agent_id });

    const shadow = await runtime.runShadow(spec.agent_id, {}, RUN);
    if (shadow.status !== "shadow_complete") {
      throw new Error(`expected shadow_complete, got ${shadow.status}: ${JSON.stringify(shadow)}`);
    }
    // The diff is the workflow the user configured — real page value on the
    // left, their configured value on the right.
    expect(shadow.diff?.changes).toEqual([
      expect.objectContaining({ field: "Phone", old_value: "555-0100", new_value: "555-0199" }),
    ]);
  });

  it("the registry the runtime holds contains no demo adapter at all", () => {
    // Structural REAL/DEMO separation: not a conditional that skips demo data,
    // but a map in which the demo adapters do not exist.
    const runtime = new LocalAgentRuntime({
      registry: realRegistry(page({})),
      runtime_id: "local-real",
      now,
    });
    const capabilities = runtime.listCapabilities();
    expect(capabilities.every((id) => id.startsWith("browser."))).toBe(true);
    expect(capabilities).not.toContain("salesforce.query_records");
    expect(capabilities).not.toContain("local.parse_csv");
  });
});

describe("registration is a validation, not a bookkeeping insert", () => {
  it("refuses a spec the runtime cannot execute, naming the capability", () => {
    const spec = compiled();
    const empty = new LocalAgentRuntime({ registry: new Map(), runtime_id: "bare", now });
    const result = empty.registerAgent(spec);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("runtime_unavailable");
    expect(result.detail).toContain("browser.propose_form_fill");
    // NOT registered: a refused agent cannot be triggered or run.
    expect(empty.get(spec.agent_id)).toBeUndefined();
  });
});

describe("the trigger is installed by registration and fires on context", () => {
  it("stages the agent when matching context is observed", () => {
    const spec = compiled({ app_category: "browser", origin: ORIGIN });
    expect(spec.trigger.type).toBe("context"); // the configured trigger SURVIVED

    const runtime = new LocalAgentRuntime({
      registry: realRegistry(page({ Phone: "555-0100" })),
      runtime_id: "local-real",
      now,
    });
    runtime.registerAgent(spec);

    const firings = runtime.handleContext(context());
    expect(firings).toHaveLength(1);
    expect(firings[0]!.agent_id).toBe(spec.agent_id);
  });

  it("DEDUPES within the cooldown, then fires again after it", () => {
    const spec = compiled({ app_category: "browser", origin: ORIGIN });
    const runtime = new LocalAgentRuntime({
      registry: realRegistry(page({ Phone: "555-0100" })),
      runtime_id: "local-real",
      now,
    });
    runtime.registerAgent(spec);

    expect(runtime.handleContext(context())).toHaveLength(1);
    // One workflow is many observation events; without dedupe, opening one
    // record stages the same agent a dozen times.
    clock += 10_000;
    expect(runtime.handleContext(context())).toHaveLength(0);
    clock += 301_000; // past the 300s cooldown
    expect(runtime.handleContext(context())).toHaveLength(1);
  });

  it("does not fire for a different origin — exact comparison, like actuation", () => {
    const spec = compiled({ app_category: "browser", origin: ORIGIN });
    const runtime = new LocalAgentRuntime({
      registry: realRegistry(page({})),
      runtime_id: "local-real",
      now,
    });
    runtime.registerAgent(spec);
    expect(runtime.handleContext(context({ domain: "acme.example.evil.test" }))).toHaveLength(0);
  });

  it("fires on its origin even when ingest categorized the site differently (#3)", () => {
    // The compiler stamps app_category "browser"; the live ingest categorizer
    // maps the SAME domain to "crm". The origin is the precise selector, so the
    // agent MUST still fire — this is the mismatch that kept every SaaS agent
    // silent forever. Host matches, category is not required.
    const spec = compiled({ app_category: "browser", origin: ORIGIN });
    const runtime = new LocalAgentRuntime({
      registry: realRegistry(page({})),
      runtime_id: "local-real",
      now,
    });
    runtime.registerAgent(spec);
    expect(runtime.handleContext(context({ app_category: "crm" }))).toHaveLength(1);
  });

  it("a disabled agent stays silent", () => {
    const spec = compiled({ app_category: "browser", origin: ORIGIN });
    const runtime = new LocalAgentRuntime({
      registry: realRegistry(page({})),
      runtime_id: "local-real",
      now,
    });
    runtime.registerAgent(spec);
    runtime.setEnabled(spec.agent_id, false);
    expect(runtime.handleContext(context())).toHaveLength(0);
  });
});

describe("restart: agents and their triggers survive", () => {
  it("rehydrates from persisted records and fires on the next context", () => {
    const spec = compiled({ app_category: "browser", origin: ORIGIN });
    const persisted: RegisteredAgent[] = [];
    const first = new LocalAgentRuntime({
      registry: realRegistry(page({ Phone: "555-0100" })),
      runtime_id: "local-real",
      now,
      onAgentChanged: (a) => {
        const i = persisted.findIndex((p) => p.spec.agent_id === a.spec.agent_id);
        if (i >= 0) persisted[i] = { ...a };
        else persisted.push({ ...a });
      },
    });
    first.registerAgent(spec);
    expect(persisted).toHaveLength(1);

    // "Restart": a NEW runtime instance, given only what was persisted.
    const second = new LocalAgentRuntime(
      { registry: realRegistry(page({ Phone: "555-0100" })), runtime_id: "local-real", now },
      persisted,
    );
    expect(second.get(spec.agent_id)?.enabled).toBe(true);
    expect(second.handleContext(context())).toHaveLength(1);
  });

  it("a restored agent the runtime can no longer execute is NOT resurrected", () => {
    // The registry changed while the app was closed — an origin revoked, a
    // connector unlinked. Restoring the agent anyway would leave it dormant
    // until a trigger crashed it mid-run.
    const spec = compiled({ app_category: "browser", origin: ORIGIN });
    const persisted: RegisteredAgent[] = [
      { spec, enabled: true, last_triggered_at: null, last_run_at: null },
    ];
    const bare = new LocalAgentRuntime({ registry: new Map(), runtime_id: "bare", now }, persisted);
    expect(bare.get(spec.agent_id)).toBeUndefined();
    expect(bare.handleContext(context())).toHaveLength(0);
  });
});

describe("shadow is structural, and inputs fail closed", () => {
  it("never dispatches the write step", async () => {
    const spec = compiled({ app_category: "browser", origin: ORIGIN });
    const host = page({ Phone: "555-0100" });
    const seen: string[] = [];
    const spying: OwnWindowHost = {
      ...host,
      evaluate: async (expr) => {
        const marker = "})(";
        const literal = expr.slice(expr.lastIndexOf(marker) + marker.length, -1);
        seen.push(
          (JSON.parse(JSON.parse(literal) as string) as { action: { kind: string } }).action.kind,
        );
        return host.evaluate(expr);
      },
    };
    const runtime = new LocalAgentRuntime({
      registry: realRegistry(spying),
      runtime_id: "local-real",
      now,
    });
    runtime.registerAgent(spec);
    await runtime.runShadow(spec.agent_id, {}, RUN);
    expect(seen).not.toContain("set_value");
    expect(seen).not.toContain("click_control");
  });

  it("a missing required input is a named refusal, not a fixture", async () => {
    // A prompt-valued step declares a required user input; shadow without the
    // answer must stop at the question.
    const workflow = taughtWorkflow();
    workflow.steps[0]!.value = { kind: "prompt", label: "The new phone number", required: true };
    const result = compileLearnedWorkflow({
      workflow,
      organization_id: RUN.organization_id,
      owner_user_id: OWNER,
      budgets: {
        max_runtime_seconds: 300,
        max_model_tokens: 0,
        max_cost_usd: 0,
        max_records_read: 100,
        max_records_written: 5,
      },
      policy: DEFAULT_ORG_POLICY,
      policy_version_id: uuidv7(),
      now: () => new Date("2026-08-09T12:05:00.000Z"),
    });
    if (result.status !== "valid") throw new Error(`expected valid, got ${result.status}`);

    const runtime = new LocalAgentRuntime({
      registry: realRegistry(page({ Phone: "555-0100" })),
      runtime_id: "local-real",
      now,
    });
    runtime.registerAgent(result.spec);
    const shadow = await runtime.runShadow(result.spec.agent_id, {}, RUN);
    expect(shadow.status).toBe("needs_input");
    if (shadow.status !== "needs_input") throw new Error("unreachable");
    expect(shadow.detail).toContain("The new phone number");
  });
});
