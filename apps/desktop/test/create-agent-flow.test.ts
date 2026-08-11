import { beforeEach, describe, expect, it, vi } from "vitest";

/** The context handler is fire-and-forget off the event bus; wait for effects. */
const settled = () => new Promise((r) => setTimeout(r, 10));
import type { PatternCandidate } from "@maman/contracts";

/**
 * CREATE AGENT, END TO END, AGAINST THE REAL SERVICE.
 *
 * The old path: compile → persist `state:"draft"` → beat → stop. These tests
 * pin the new one — compile → validate → persist → REGISTER with the local
 * runtime → trigger installed → shadow run — and the proactive half: a
 * matching workflow context stages the agent without anyone opening a screen,
 * and everything survives a restart.
 *
 * No cloud key exists in this process; the "page" is the in-page protocol over
 * a mocked bridge, which is the production execution path minus a live window.
 */

delete process.env.OPENAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

const ORIGIN = "https://acme.example";

/** In-memory stand-ins for the Rust commands, plus a local app-event bus. */
let agentsJson: string | null = null;
/** The representative trace the store would return, or null (legacy path). */
let storedTrace: string | null = null;
const pageFields = new Map<string, string>([["Phone", "555-0100"]]);
type Listener = (e: unknown) => void;
const listeners: Listener[] = [];

vi.mock("../src/lib/bridge.js", () => ({
  isTauri: () => true,
  invokeCommand: async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "agents_load") return agentsJson;
    if (cmd === "agents_save") {
      agentsJson = (args?.json as string) ?? null;
      return undefined;
    }
    if (cmd === "action_trace_lookup") return storedTrace;
    if (cmd === "agent_browser_origin") return ORIGIN;
    if (cmd === "agent_browser_evaluate") {
      const expression = args?.expression as string;
      const marker = "})(";
      const literal = expression.slice(expression.lastIndexOf(marker) + marker.length, -1);
      const { request_id, action } = JSON.parse(JSON.parse(literal) as string) as {
        request_id: string;
        action: { kind: string; roles?: string[]; target?: { name: string } };
      };
      if (action.kind === "list_controls") {
        return JSON.stringify({
          request_id,
          outcome: "observed",
          observed: {
            accessible_name: "",
            match_count: 1,
            controls: [...pageFields.keys()].map((name) => ({
              role: "textbox",
              name,
              secure: false,
              editable: true,
              duplicate_count: 1,
            })),
          },
        });
      }
      const name = action.target?.name ?? "";
      if (action.kind === "read_field" && pageFields.has(name)) {
        return JSON.stringify({
          request_id,
          outcome: "observed",
          observed: { value_after: pageFields.get(name), accessible_name: name, match_count: 1 },
        });
      }
      return JSON.stringify({ request_id, outcome: "refused", refusal_reason: "target_not_found" });
    }
    return undefined;
  },
  emitAppEvent: async (event: unknown) => {
    for (const l of [...listeners]) l(event);
  },
  onAppEvent: async (listener: Listener) => {
    listeners.push(listener);
    return () => listeners.splice(listeners.indexOf(listener), 1);
  },
}));

const { useAgents } = await import("../src/lib/agents.js");
const { useSettings } = await import("../src/state/settings.js");
const {
  bootAgentService,
  createAgentAndActivate,
  agentRuntime,
  useAgentService,
  __resetAgentServiceForTests,
} = await import("../src/lib/agentService.js");
const { emitAppEvent } = await import("../src/lib/bridge.js");

function candidate(): PatternCandidate {
  return {
    pattern_id: "018f0000-0000-7000-8000-0000000000e1",
    owner_user_id: "018f0000-0000-7000-8000-0000000000aa",
    first_seen_at: "2026-08-01T09:00:00.000Z",
    last_seen_at: "2026-08-02T09:00:00.000Z",
    occurrence_count: 9,
    distinct_day_count: 4,
    median_duration_ms: 7 * 60_000,
    p90_duration_ms: 9 * 60_000,
    canonical_sequence: [
      "chrome_ext:browser:element_focused:textbox:phone:contact",
      "chrome_ext:browser:value_committed:textbox:phone:contact",
    ],
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

const INTENT = "automate_record_workflow";

async function createOne() {
  return createAgentAndActivate(candidate(), INTENT, "Fill the phone field.", "phone helper");
}

function matchingContext() {
  return {
    type: "workflow_context" as const,
    context: {
      source: "chrome_ext",
      app_category: "browser",
      event_type: "element_focused",
      target_role: "textbox",
      semantic_type: "phone",
      object_type: "contact",
      domain: "acme.example",
      occurred_at: new Date().toISOString(),
    },
  };
}

beforeEach(async () => {
  agentsJson = null;
  storedTrace = null;
  listeners.length = 0;
  __resetAgentServiceForTests();
  useAgents.setState({ agents: [], hydrated: false, loadFailure: null, discarded: 0 });
  useSettings.setState((s) => ({
    settings: { ...s.settings, browser_actuation_origins: [ORIGIN] },
  }));
  await bootAgentService();
});

describe("Create Agent is the whole verb", () => {
  it("compiles, registers, installs the trigger, shadow-runs — and does NOT end draft", async () => {
    const result = await createOne();
    if (!result.ok) throw new Error(`create failed: ${result.message}`);

    // Persisted state left draft.
    const record = useAgents.getState().agents.find((a) => a.agent_id === result.agent_id)!;
    expect(record.state).toBe("shadow");

    // Registered with a runtime that can execute it.
    const registered = agentRuntime().get(result.agent_id);
    expect(registered).toBeDefined();

    // The trigger is on the persisted spec — derived from the pattern, not manual.
    const spec = record.versions[record.versions.length - 1]!.spec;
    expect(spec.trigger).toMatchObject({
      type: "context",
      app_category: "browser",
      object_type: "contact",
      origin: ORIGIN,
    });

    // The shadow ran. This agent writes, and no one has supplied the value, so
    // the honest immediate outcome is the ASK — not a fixture-backed success.
    expect(result.shadow.status).toBe("needs_input");
  });

  it("shows real lifecycle progress, ending in a specific sentence", async () => {
    await createOne();
    const phases = useAgentService.getState().creation.map((c) => c.phase);
    expect(phases).toEqual([
      "compiling",
      "installing_trigger",
      "checking_runtime",
      "registering",
      "shadow_running",
      "done",
    ]);
    const done = useAgentService.getState().creation.at(-1)!;
    expect(done.detail).toContain("Agent created");
    expect(done.detail).not.toBe("Something went wrong.");
  });

  it("a registration failure is named, and the record stays draft", async () => {
    // No actuation origins → the browser adapters exist but the compile-time
    // registry gate refuses, or registration names the gap. Either way: no
    // success, no shadow state, a specific message.
    useSettings.setState((s) => ({ settings: { ...s.settings, browser_actuation_origins: [] } }));
    __resetAgentServiceForTests();
    await bootAgentService();

    const result = await createOne();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message.length).toBeGreaterThan(10);
    const record = useAgents.getState().agents[0];
    if (record) expect(record.state).toBe("draft");
  });
});

describe("the agent is proactive without any screen", () => {
  it("a matching context stages a suggestion; a repeat within cooldown does not", async () => {
    const created = await createOne();
    if (!created.ok) throw new Error("create failed");

    await emitAppEvent(matchingContext());
    await settled();
    expect(useAgentService.getState().staged).toHaveLength(1);
    expect(useAgentService.getState().staged[0]).toMatchObject({
      agent_id: created.agent_id,
      outcome: { kind: "suggested" },
    });

    // The same workflow emits many events; the agent must not pile up.
    await emitAppEvent(matchingContext());
    await settled();
    expect(useAgentService.getState().staged).toHaveLength(1);

    // And the firing is persisted history, not ephemeral UI state.
    const record = useAgents.getState().agents.find((a) => a.agent_id === created.agent_id)!;
    expect(record.last_triggered_at).not.toBeNull();
  });

  it("a non-matching context stages nothing", async () => {
    await createOne();
    await emitAppEvent({
      ...matchingContext(),
      context: { ...matchingContext().context, app_category: "email" },
    });
    await settled();
    expect(useAgentService.getState().staged).toHaveLength(0);
  });
});

describe("the Rust daemon's firings reach the same staging path", () => {
  it("stages a firing the daemon evaluated, without local re-evaluation", async () => {
    const created = await createOne();
    if (!created.ok) throw new Error("create failed");

    // What Rust emits after evaluating a LIVE event — the panel was not
    // involved in the match at all.
    await emitAppEvent({
      type: "agent_trigger_fired",
      firing: {
        agent_id: created.agent_id,
        agent_name: "phone helper",
        at: new Date().toISOString(),
        context: matchingContext().context,
      },
    });
    await settled();
    expect(useAgentService.getState().staged).toHaveLength(1);
    expect(useAgentService.getState().staged[0]!.agent_id).toBe(created.agent_id);
  });

  it("collapses double delivery when both evaluators announce the same firing", async () => {
    // The daemon and the panel runtime hold separate cooldown maps, so one
    // live event can arrive twice: once as workflow_context (panel evaluates)
    // and once as agent_trigger_fired (daemon evaluated). One staged entry.
    const created = await createOne();
    if (!created.ok) throw new Error("create failed");
    const at = new Date().toISOString();

    await emitAppEvent(matchingContext());
    await emitAppEvent({
      type: "agent_trigger_fired",
      firing: {
        agent_id: created.agent_id,
        agent_name: "phone helper",
        at,
        context: matchingContext().context,
      },
    });
    await settled();
    expect(useAgentService.getState().staged).toHaveLength(1);
  });
});

describe("restart: the agent and its trigger come back", () => {
  it("reboots from the persisted file and fires on the next matching context", async () => {
    const created = await createOne();
    if (!created.ok) throw new Error("create failed");

    // "Restart": drop every in-memory singleton; keep only agentsJson (the file).
    __resetAgentServiceForTests();
    listeners.length = 0;
    useAgents.setState({ agents: [], hydrated: false, loadFailure: null, discarded: 0 });
    await bootAgentService();

    expect(agentRuntime().get(created.agent_id)).toBeDefined();
    await emitAppEvent(matchingContext());
    await settled();
    expect(useAgentService.getState().staged).toHaveLength(1);
  });
});

describe("Create Agent compiles from the trace when one exists", () => {
  const TRACE = {
    schema_version: 1,
    trace_id: "018f0000-0000-7000-8000-00000000t1aa".replace("t1", "b1"),
    started_at: "2026-08-10T09:00:00.000Z",
    ended_at: "2026-08-10T09:02:00.000Z",
    apps: [{ category: "browser", origin: ORIGIN }],
    steps: [
      {
        order: 1,
        surface: "browser_dom",
        origin: ORIGIN,
        operation: "read_field",
        target: { role: "textbox", accessible_name: "Phone", ancestry: [], menu_path: [] },
        value_binding: { kind: "none" },
        preconditions: { requires_foreground: false, requires_user_presence: false },
      },
      {
        order: 2,
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

  it("produces a spec with trace provenance, registers it, and shadows", async () => {
    storedTrace = JSON.stringify(TRACE);
    const result = await createOne();
    if (!result.ok) throw new Error(`create failed: ${result.message}`);

    const record = useAgents.getState().agents.find((a) => a.agent_id === result.agent_id)!;
    const spec = record.versions[record.versions.length - 1]!.spec;
    // Compiled FROM THE EVIDENCE: provenance recorded, honest compiler identity,
    // and the trigger comes from the trace's own origin.
    expect(spec.compiler).toBe("deterministic-local");
    expect(spec.source_trace_id).toBe(TRACE.trace_id);
    expect(spec.trigger).toMatchObject({ type: "context", origin: ORIGIN });
    // Registered and past draft — the click is still the whole verb.
    expect(record.state).toBe("shadow");
    expect(agentRuntime().get(result.agent_id)).toBeDefined();
    // And it is NOT the recipe path's output.
    expect(JSON.stringify(spec).toLowerCase()).not.toContain("reconcil");
  });

  it("refuses with the typed question when the trace cannot compile — no recipe fallback", async () => {
    storedTrace = JSON.stringify({
      ...TRACE,
      steps: [{ ...TRACE.steps[0], operation: "drag_and_drop" }],
    });
    const result = await createOne();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    // The refusal names what was watched; nothing fell back to compile-learned.
    expect(result.message).toContain("drag and drop");
    expect(result.missing_configuration?.[0]?.kind).toBe("workflow_definition");
    expect(useAgents.getState().agents.filter((a) => a.state === "shadow")).toHaveLength(0);
  });

  it("falls back to the legacy pattern path when no trace exists", async () => {
    storedTrace = null;
    const result = await createOne();
    if (!result.ok) throw new Error(`create failed: ${result.message}`);
    const record = useAgents.getState().agents.find((a) => a.agent_id === result.agent_id)!;
    const spec = record.versions[record.versions.length - 1]!.spec;
    // Legacy candidates predate capture; they keep working, without provenance.
    expect(spec.source_trace_id).toBeUndefined();
    expect(record.state).toBe("shadow");
  });
});
