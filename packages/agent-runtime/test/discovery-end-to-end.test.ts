import { describe, expect, it } from "vitest";
import type { OwnWindowHost } from "@maman/browser-actuator";
import { UPDATE_FIELD_ON_OPEN_RECORD } from "@maman/intent-layer";
import { uuidv7, type PatternCandidate } from "@maman/contracts";
import { DEFAULT_ORG_POLICY } from "@maman/policy-engine";
import {
  browserAdapters,
  discoverSurface,
  type BrowserAdapterDeps,
} from "../src/browser-adapters.js";
import { resolveIntentOnSurface } from "../src/resolve-on-surface.js";
import {
  compileAgentSpec,
  DISCOVERED_FIELDS_INPUT,
  FIELD_VALUES_INPUT,
  type CompileRequest,
} from "../src/compiler.js";
import { executeStep } from "../src/run-engine.js";
import { requireAdapter } from "../src/runtime-capabilities.js";
import type { CapabilityContext } from "../src/adapters.js";

/**
 * THE LOOP THIS FILE EXISTS TO CLOSE.
 *
 * The browser recipe compiled a spec whose first step asked for `fields`, and
 * nothing supplied them, so EVERY compiled browser agent failed on step one
 * with "No fields were configured to read. Teach the workflow which fields
 * matter first." Detection worked, compilation worked, the agent existed — and
 * it could not take a single action without a human typing in the name of a
 * field that was already on the screen in front of them.
 *
 * These tests drive the real path: compile → look at the page → resolve the
 * intent against the controls that are actually there → execute. Nothing here
 * is told a field name.
 */

const ORIGIN = "https://acme.example";
const RUN: CapabilityContext = {
  run_id: "019fc4d0-130f-706e-b94e-42a86e9b3812",
  organization_id: "019fc4d0-130f-706e-b94e-42a86e9b3814",
  owner_user_id: "019fc4d0-130f-706e-b94e-42a86e9b3815",
  mode: "supervised",
};

/** A page with real controls, which answers `list_controls` and `read_field`. */
function page(controls: Array<{ name: string; role?: string; value?: string; secure?: boolean }>) {
  const values = new Map(controls.map((c) => [c.name, c.value ?? ""]));
  const host: OwnWindowHost = {
    currentOrigin: async () => ORIGIN,
    navigate: async () => undefined,
    evaluate: async (expression: string) => {
      const marker = "})(";
      const literal = expression.slice(expression.lastIndexOf(marker) + marker.length, -1);
      const payload = JSON.parse(JSON.parse(literal) as string) as {
        request_id: string;
        action: { kind: string; roles?: string[]; target?: { name: string }; value?: string };
      };
      const { request_id, action } = payload;

      if (action.kind === "list_controls") {
        const listed = controls
          .map((c) => ({
            role: c.role ?? "textbox",
            name: c.name,
            secure: c.secure ?? false,
            editable: true,
            duplicate_count: 1,
          }))
          .filter((c) => (action.roles ?? []).includes(c.role));
        return JSON.stringify({
          request_id,
          outcome: "observed",
          observed: { accessible_name: "", match_count: listed.length, controls: listed },
        });
      }
      const name = action.target?.name ?? "";
      if (action.kind === "read_field") {
        return values.has(name)
          ? JSON.stringify({
              request_id,
              outcome: "observed",
              observed: { value_after: values.get(name), accessible_name: name, match_count: 1 },
            })
          : JSON.stringify({ request_id, outcome: "refused", refusal_reason: "target_not_found" });
      }
      if (action.kind === "set_value") {
        values.set(name, action.value ?? "");
        return JSON.stringify({
          request_id,
          outcome: "applied",
          observed: { value_after: values.get(name), accessible_name: name, match_count: 1 },
        });
      }
      return JSON.stringify({ request_id, outcome: "failed", detail: "unsupported" });
    },
  };
  return { host, values };
}

function deps(host: OwnWindowHost, over: Partial<BrowserAdapterDeps> = {}): BrowserAdapterDeps {
  let n = 0;
  return {
    host,
    allowedOrigins: [ORIGIN],
    userPresent: () => true,
    allowSupervisedBrowserWrites: true,
    newRequestId: () => `019fc4d0-130f-706e-b94e-4100000000${(n++).toString().padStart(2, "0")}`,
    mintAuthorization: () => "z".repeat(43),
    now: () => new Date("2026-08-07T12:00:00.000Z"),
    ...over,
  };
}

/** The live device's own pattern shape, with the observer's semantics attached. */
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

const WITH_SEMANTICS = [
  "chrome_ext:browser:element_focused:textbox:phone:contact",
  "chrome_ext:browser:value_committed:textbox:phone:contact",
];

function compileRequest(sequence: string[]): CompileRequest {
  return {
    candidate: candidate(sequence),
    generalized_intent: "automate_record_workflow",
    desired_outcome: "Fill the fields I fill on this page.",
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
  };
}

describe("the agent looks at the page instead of being taught it", () => {
  it("lists the page's controls without reporting a single value", async () => {
    const { host } = page([
      { name: "Phone", value: "555-0100" },
      { name: "Email", value: "someone@acme.example" },
    ]);
    const surface = await discoverSurface(deps(host), RUN);
    expect(surface.origin).toBe(ORIGIN);
    expect(surface.controls.map((c) => c.name).sort()).toEqual(["Email", "Phone"]);
    // The values exist on this page and must not have travelled with the shape.
    expect(JSON.stringify(surface)).not.toContain("555-0100");
    expect(JSON.stringify(surface)).not.toContain("someone@acme.example");
  });

  it("finds the field the user was observed using, among several", async () => {
    const { host } = page([
      { name: "Email", value: "a@b.test" },
      { name: "Phone", value: "555-0100" },
      { name: "Internal notes", value: "" },
    ]);
    const resolution = await resolveIntentOnSurface({
      intent: UPDATE_FIELD_ON_OPEN_RECORD,
      deps: deps(host),
      ctx: RUN,
      supplied: { new_value: "555-0199" },
      observedSemantics: ["phone"],
    });
    if (resolution.status !== "ready") throw new Error(`expected ready, got ${resolution.status}`);
    expect(resolution.fields).toEqual([{ name: "Phone" }]);
    // Provenance: found by looking, not handed over.
    expect(resolution.resolved.filled.find((f) => f.kind === "field")?.source).toBe(
      "discovered_on_surface",
    );
  });

  it("never offers a credential box as a target", async () => {
    // The listing includes it so the agent can see it; resolution must not
    // treat it as somewhere to type.
    const { host } = page([{ name: "Phone", secure: true, value: "" }]);
    const resolution = await resolveIntentOnSurface({
      intent: UPDATE_FIELD_ON_OPEN_RECORD,
      deps: deps(host),
      ctx: RUN,
      supplied: { new_value: "555-0199" },
      observedSemantics: ["phone"],
    });
    expect(resolution.status).toBe("needs_you");
  });

  it("refuses when a name matches several controls, rather than taking the first", async () => {
    const { host } = page([
      { name: "Phone", value: "555-0100" },
      { name: "Phone", value: "555-0200" },
    ]);
    const resolution = await resolveIntentOnSurface({
      intent: UPDATE_FIELD_ON_OPEN_RECORD,
      deps: deps(host),
      ctx: RUN,
      supplied: { new_value: "555-0199" },
      observedSemantics: ["phone"],
    });
    if (resolution.status !== "needs_you") throw new Error("expected a refusal");
    expect(resolution.resolved.unfilled.find((u) => u.kind === "field")?.reason).toBe(
      "ambiguous_controls",
    );
  });

  it("says it could not LOOK, which is not the same as finding nothing", async () => {
    // A window that is not open must not be reported as a page with no fields:
    // the user would go and configure a field that is already there.
    const closed: OwnWindowHost = {
      currentOrigin: async () => null,
      navigate: async () => undefined,
      evaluate: async () => "",
    };
    const resolution = await resolveIntentOnSurface({
      intent: UPDATE_FIELD_ON_OPEN_RECORD,
      deps: deps(closed),
      ctx: RUN,
      supplied: { new_value: "x" },
    });
    expect(resolution.status).toBe("could_not_look");
    if (resolution.status !== "could_not_look") throw new Error("unreachable");
    expect(resolution.message).toMatch(/not open/);
  });
});

describe("a compiled agent runs against a page nobody taught it", () => {
  it("EXECUTES step one, which used to be impossible", async () => {
    // The exact failure: "No fields were configured to read. Teach the workflow
    // which fields matter first." — thrown by the first step of every browser
    // agent ever compiled, because the recipe bound no fields and nothing else
    // supplied them.
    const compiled = await compileAgentSpec(compileRequest(WITH_SEMANTICS));
    if (compiled.status !== "valid") throw new Error(`expected valid, got ${compiled.status}`);

    const { host } = page([
      { name: "Phone", value: "555-0100" },
      { name: "Internal notes", value: "" },
    ]);
    const d = deps(host);

    const resolution = await resolveIntentOnSurface({
      intent: UPDATE_FIELD_ON_OPEN_RECORD,
      deps: d,
      ctx: RUN,
      supplied: { new_value: "555-0199" },
      observedSemantics: ["phone"],
    });
    if (resolution.status !== "ready") throw new Error(`expected ready, got ${resolution.status}`);

    const registry = browserAdapters(d);
    const readStep = compiled.spec.steps[0]!;
    const state = { outputs: {} };
    const result = await executeStep({
      spec: compiled.spec,
      step: readStep,
      state,
      // Bound from DISCOVERY, exactly as the desktop run path binds it.
      agentInputs: { [DISCOVERED_FIELDS_INPUT]: resolution.fields },
      ctx: RUN,
      adapter: requireAdapter(registry, readStep, "local"),
    });

    expect(result.kind).toBe("read");
    expect((result as { output: { values: Record<string, string> } }).output.values).toEqual({
      Phone: "555-0100",
    });
    // It read the field it discovered, and left the one it did not.
    expect(
      (result as { output: { values: Record<string, string> } }).output.values["Internal notes"],
    ).toBeUndefined();
  });

  it("declares the discovered input rather than pretending the user supplies it", async () => {
    const compiled = await compileAgentSpec(compileRequest(WITH_SEMANTICS));
    if (compiled.status !== "valid") throw new Error("expected valid");
    // The two inputs are separated by SOURCE, which is the whole point: one is
    // found by looking and one can only be told.
    expect(compiled.spec.inputs.find((i) => i.key === DISCOVERED_FIELDS_INPUT)?.source).toBe(
      "discovered_on_surface",
    );
    expect(compiled.spec.inputs.find((i) => i.key === FIELD_VALUES_INPUT)?.source).toBe("user");

    const provides = compiled.plain_language_plan.find((l) => l.startsWith("You provide:"))!;
    expect(provides).toContain("What the field should say");
    // Asking someone to provide the field the agent finds for itself would send
    // them looking for a form that does not exist.
    expect(provides).not.toContain("which I find by looking");
    expect(compiled.plain_language_plan.some((l) => /I work out for myself/.test(l))).toBe(true);
  });

  it("stops and ASKS for the value rather than inventing one", async () => {
    // No page reveals what a person intends to type. With the value unsupplied
    // the intent cannot resolve, and the run must stop at a question instead of
    // reaching a write with something made up in the box.
    const { host, values } = page([{ name: "Phone", value: "555-0100" }]);
    const resolution = await resolveIntentOnSurface({
      intent: UPDATE_FIELD_ON_OPEN_RECORD,
      deps: deps(host),
      ctx: RUN,
      observedSemantics: ["phone"],
    });
    if (resolution.status !== "needs_you") throw new Error(`expected needs_you`);
    expect(resolution.answerable_by_user).toBe(true);
    expect(resolution.message).toMatch(/tell me/);
    // It found the field — the gap is only the value.
    expect(resolution.resolved.filled.find((f) => f.kind === "field")?.value).toBe("Phone");
    expect(values.get("Phone")).toBe("555-0100");
  });

  it("writes only the discovered field, and the readback proves it landed", async () => {
    const compiled = await compileAgentSpec(compileRequest(WITH_SEMANTICS));
    if (compiled.status !== "valid") throw new Error("expected valid");

    const { host, values } = page([
      { name: "Phone", value: "555-0100" },
      { name: "Internal notes", value: "leave me alone" },
    ]);
    const d = deps(host);
    const registry = browserAdapters(d);
    const state = { outputs: {} };
    // Two inputs with two different sources: the control comes from looking,
    // and the value comes from the user, because no page reveals it.
    const agentInputs = {
      [DISCOVERED_FIELDS_INPUT]: [{ name: "Phone" }],
      [FIELD_VALUES_INPUT]: [{ name: "Phone", value: "555-0199" }],
    };

    // PROPOSE, from the live page: the diff's "before" is what the field really
    // holds, not what anything assumed.
    const proposeStep = compiled.spec.steps.find((s) => s.mode === "propose_write")!;
    const proposed = await executeStep({
      spec: compiled.spec,
      step: proposeStep,
      state,
      agentInputs,
      ctx: RUN,
      adapter: requireAdapter(registry, proposeStep, "local"),
    });
    if (proposed.kind !== "proposed") throw new Error("expected a proposal");
    expect(proposed.diff.changes).toHaveLength(1);
    expect(proposed.diff.changes[0]).toMatchObject({
      field: "Phone",
      old_value: "555-0100",
      new_value: "555-0199",
    });

    // WRITE, bound to the approved diff's hash.
    const writeStep = compiled.spec.steps.find((s) => s.mode === "write")!;
    const written = await executeStep({
      spec: compiled.spec,
      step: writeStep,
      state,
      agentInputs: { ...agentInputs, proposal: proposed.diff },
      ctx: RUN,
      adapter: requireAdapter(registry, writeStep, "local"),
      approvedDiff: proposed.diff,
      approvedDiffSha: proposed.diff_sha256,
    });
    if (written.kind !== "written") throw new Error(`expected a write, got ${written.kind}`);

    expect(values.get("Phone")).toBe("555-0199");
    // The field nobody discovered is untouched.
    expect(values.get("Internal notes")).toBe("leave me alone");
    expect(written.verified).toBe(true);
  });
});
