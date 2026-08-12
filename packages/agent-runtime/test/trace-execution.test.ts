import { beforeAll, describe, expect, it } from "vitest";
import type { LocalActionTrace } from "@maman/contracts";
import {
  browserAdapters,
  compileTraceToAgentSpec,
  diffSha256,
  LocalAgentRuntime,
  type BrowserAdapterDeps,
} from "../src/index.js";

/**
 * THE WHOLE ARROW, ON ONE TRACE:
 *
 *   observed trace → compile (propose + WRITE pairs) → register → shadow
 *   (ONE merged diff for the whole routine) → approve that exact hash →
 *   execute → the page actually changes → independent readback verifies —
 *   and when the page moves between approval and execution, NOTHING writes.
 *
 * This is the test the v1 compiler could never pass: its specs had no write
 * steps, so runApproved ended every run with "no write step to approve".
 * No model key, no fixture, no demo adapter — the "page" is a mutable field
 * map behind the same dispatch transport production uses.
 */

beforeAll(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GROQ_API_KEY;
});

const ORIGIN = "https://leads.example";

/** A mutable page behind the relay dispatch: set_value changes it for real. */
function relayPage(initial: Record<string, string>, buttons: string[] = []) {
  const fields = { ...initial };
  const clicks: string[] = [];
  const dispatch = async (request: unknown): Promise<unknown> => {
    const { request_id, run_id, step_id, action } = request as {
      request_id: string;
      run_id: string;
      step_id: string;
      action: {
        kind: string;
        roles?: string[];
        target?: { role: string; name: string };
        value?: string;
        expect_current?: string;
        confirm_name?: string;
      };
    };
    const base = {
      schema_version: 1,
      type: "browser_action_result",
      request_id,
      run_id,
      step_id,
      completed_at: "2026-08-10T10:00:01.000Z",
    };
    if (action.kind === "list_controls") {
      const roles = action.roles ?? [];
      const controls = [
        ...Object.keys(fields).map((name) => ({
          role: "textbox",
          name,
          secure: false,
          editable: true,
          duplicate_count: 1,
        })),
        ...buttons.map((name) => ({
          role: "button",
          name,
          secure: false,
          editable: true,
          duplicate_count: 1,
        })),
      ].filter((c) => roles.includes(c.role));
      return {
        ...base,
        outcome: "observed",
        observed: {
          resolved_name: "",
          match_count: controls.length,
          origin: ORIGIN,
          controls,
          controls_truncated: false,
        },
      };
    }
    const name = action.target?.name ?? "";
    if (action.kind === "read_field" && name in fields) {
      return {
        ...base,
        outcome: "observed",
        observed: {
          value_after: fields[name],
          resolved_name: name,
          match_count: 1,
          origin: ORIGIN,
        },
      };
    }
    if (action.kind === "set_value" && name in fields) {
      if (action.expect_current !== undefined && fields[name] !== action.expect_current) {
        return {
          ...base,
          outcome: "refused",
          refusal_reason: "precondition_failed",
          observed: { resolved_name: name, match_count: 1, origin: ORIGIN },
        };
      }
      const before = fields[name]!;
      fields[name] = action.value ?? "";
      return {
        ...base,
        outcome: "applied",
        observed: {
          value_before: before,
          value_after: fields[name],
          resolved_name: name,
          match_count: 1,
          origin: ORIGIN,
        },
      };
    }
    if (action.kind === "click_control" && buttons.includes(name)) {
      if (action.confirm_name !== undefined && action.confirm_name !== name) {
        return {
          ...base,
          outcome: "refused",
          refusal_reason: "confirm_name_mismatch",
          observed: { resolved_name: name, match_count: 1, origin: ORIGIN },
        };
      }
      clicks.push(name);
      return {
        ...base,
        outcome: "applied",
        observed: { resolved_name: name, match_count: 1, origin: ORIGIN },
      };
    }
    return {
      ...base,
      outcome: "refused",
      refusal_reason: "no_match",
      observed: { resolved_name: "", match_count: 0, origin: ORIGIN },
    };
  };
  return { fields, clicks, dispatch };
}

function deps(dispatch: BrowserAdapterDeps["dispatch"]): BrowserAdapterDeps {
  let n = 0;
  return {
    ...(dispatch ? { dispatch } : {}),
    allowedOrigins: [ORIGIN],
    userPresent: () => true,
    allowSupervisedBrowserWrites: true,
    newRequestId: () => `019fc4d0-130f-706e-b94e-6000000000${(n++).toString().padStart(2, "0")}`,
    mintAuthorization: () => "z".repeat(43),
    now: () => new Date("2026-08-10T10:00:00.000Z"),
  };
}

/** The routine everyone actually has: read a value, fill a field, press Save. */
const TRACE: LocalActionTrace = {
  schema_version: 1,
  trace_id: "018f0000-0000-7000-8000-00000000e2aa",
  started_at: "2026-08-10T09:00:00.000Z",
  ended_at: "2026-08-10T09:02:00.000Z",
  apps: [{ category: "browser", origin: ORIGIN }],
  steps: [
    {
      order: 1,
      surface: "browser_dom",
      origin: ORIGIN,
      operation: "read_field",
      target: { role: "textbox", accessible_name: "Company Domain", ancestry: [], menu_path: [] },
      value_binding: { kind: "none" },
      preconditions: { requires_foreground: false, requires_user_presence: false },
    },
    {
      order: 2,
      surface: "browser_dom",
      origin: ORIGIN,
      operation: "set_value",
      target: { role: "textbox", accessible_name: "Website", ancestry: [], menu_path: [] },
      value_binding: { kind: "from_step", step: 1, output: "Company Domain" },
      preconditions: { requires_foreground: true, requires_user_presence: true },
      expected_effect: { kind: "value_committed", readback: "reread_target" },
    },
    {
      order: 3,
      surface: "browser_dom",
      origin: ORIGIN,
      operation: "press",
      target: { role: "button", accessible_name: "Save", ancestry: [], menu_path: [] },
      value_binding: { kind: "none" },
      preconditions: { requires_foreground: true, requires_user_presence: true },
      expected_effect: { kind: "record_updated", readback: "reread_target" },
    },
  ],
  protected_segments: [],
  pattern_event_refs: [],
  local_only: true,
};

function compiledRuntime(page: ReturnType<typeof relayPage>) {
  const registry = browserAdapters(deps(page.dispatch));
  const result = compileTraceToAgentSpec({
    trace: TRACE,
    pattern_id: "018f0000-0000-7000-8000-00000000e2f1",
    owner_user_id: "018f0000-0000-7000-8000-00000000e2f2",
    organization_id: "018f0000-0000-7000-8000-00000000e2f3",
    name: "Copy the domain into Website and save",
    availableCapabilities: new Set(registry.keys()),
    now: () => new Date("2026-08-10T10:00:00.000Z"),
  });
  if (!result.ok) throw new Error(`compile failed: ${result.detail}`);
  const runtime = new LocalAgentRuntime({ registry, runtime_id: "local-real" });
  const registered = runtime.registerAgent(result.spec);
  if (!registered.ok) throw new Error(`register failed: ${registered.detail}`);
  return { runtime, spec: result.spec };
}

const CTX = {
  run_id: "019fc4d0-130f-706e-b94e-60000000aa01",
  organization_id: "018f0000-0000-7000-8000-00000000e2f3",
  owner_user_id: "018f0000-0000-7000-8000-00000000e2f2",
};

describe("a trace-compiled agent EXECUTES, end to end", () => {
  it("shadow proposes ONE merged diff for the whole routine", async () => {
    const page = relayPage({ "Company Domain": "acme.com", Website: "" }, ["Save"]);
    const { runtime, spec } = compiledRuntime(page);

    const shadow = await runtime.runShadow(spec.agent_id, {}, CTX);
    if (shadow.status !== "shadow_complete" || !shadow.diff) {
      throw new Error(`expected a proposal, got ${JSON.stringify(shadow)}`);
    }
    // The fill AND the press, in plan order — not just the last step's diff.
    expect(shadow.diff.changes.map((c) => c.field)).toEqual(["Website", "Save"]);
    expect(shadow.diff.changes[0]).toMatchObject({ old_value: "", new_value: "acme.com" });
    // Shadow never writes.
    expect(page.fields["Website"]).toBe("");
    expect(page.clicks).toEqual([]);
  });

  it("approving the exact merged hash executes the writes and reads them back", async () => {
    const page = relayPage({ "Company Domain": "acme.com", Website: "" }, ["Save"]);
    const { runtime, spec } = compiledRuntime(page);

    const shadow = await runtime.runShadow(spec.agent_id, {}, CTX);
    if (shadow.status !== "shadow_complete" || !shadow.diff) throw new Error("no proposal");
    const approvedSha = diffSha256(shadow.diff);

    const outcome = await runtime.runApproved(spec.agent_id, {}, CTX, approvedSha);
    if (outcome.status !== "completed") {
      throw new Error(`expected completion, got ${JSON.stringify(outcome)}`);
    }
    // The page ACTUALLY changed, the button was ACTUALLY pressed…
    expect(page.fields["Website"]).toBe("acme.com");
    expect(page.clicks).toEqual(["Save"]);
    // …and the field write was independently READ BACK. The press has no
    // independent readback (nothing re-readable proves a click's effects), so
    // the run as a whole HONESTLY does not claim "verified" — the receipt
    // names what was and was not confirmed instead of rounding up.
    expect(outcome.verified).toBe(false);
    expect(outcome.verify_detail.toLowerCase()).toContain("verif");
  });

  it("aborts with NOTHING written when the page moved after approval", async () => {
    const page = relayPage({ "Company Domain": "acme.com", Website: "" }, ["Save"]);
    const { runtime, spec } = compiledRuntime(page);

    const shadow = await runtime.runShadow(spec.agent_id, {}, CTX);
    if (shadow.status !== "shadow_complete" || !shadow.diff) throw new Error("no proposal");
    const approvedSha = diffSha256(shadow.diff);

    // Someone edits the record between approval and execution.
    page.fields["Company Domain"] = "other.example";

    const outcome = await runtime.runApproved(spec.agent_id, {}, CTX, approvedSha);
    expect(outcome.status).toBe("aborted_stale");
    // The staleness check ran over the WHOLE plan before any write — the field
    // is untouched and the button unpressed. A pairwise check would have
    // pressed Save against half a routine.
    expect(page.fields["Website"]).toBe("");
    expect(page.clicks).toEqual([]);
  });

  it("a wrong hash writes nothing at all", async () => {
    const page = relayPage({ "Company Domain": "acme.com", Website: "" }, ["Save"]);
    const { runtime, spec } = compiledRuntime(page);
    const outcome = await runtime.runApproved(spec.agent_id, {}, CTX, "not-the-approved-hash");
    expect(outcome.status).toBe("aborted_stale");
    expect(page.fields["Website"]).toBe("");
    expect(page.clicks).toEqual([]);
  });
});
