/**
 * @vitest-environment jsdom
 *
 * jsdom because the actuator's presence gate is real here (as in
 * acceptance.test.ts): discovery fails closed without a visible document, and
 * a queue test whose runs all refuse before dispatch would measure nothing —
 * the totalEvaluates guard below enforces that.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { uuidv7, type PatternCandidate } from "@maman/contracts";

/**
 * MANY AGENTS, ONE MACHINE.
 *
 * Autonomous shadow runs share a single browser surface, so when a burst of
 * firings arrives — many agents, one context — they must run through the
 * worker pool a few at a time, not all at once. This pins the cap: with five
 * autonomy-granted agents fired simultaneously, the page protocol never sees
 * more than MAX_CONCURRENT_SHADOWS dispatches in flight, and every agent still
 * gets its staged outcome.
 */

delete process.env.OPENAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

const ORIGIN = "https://acme.example";

let agentsJson: string | null = null;
const pageFields = new Map<string, string>([["Phone", "555-0100"]]);
type Listener = (e: unknown) => void;
const listeners: Listener[] = [];

/** Concurrency instrumentation: how many evaluate calls overlap right now. */
let inFlightEvaluates = 0;
let maxConcurrentEvaluates = 0;
let totalEvaluates = 0;

vi.mock("../src/lib/bridge.js", () => ({
  isTauri: () => true,
  invokeCommand: async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "agents_load") return agentsJson;
    if (cmd === "agents_save") {
      agentsJson = (args?.json as string) ?? null;
      return undefined;
    }
    if (cmd === "staged_runs_drain") return "[]";
    if (cmd === "browser_relay_status") return { connected: true, in_flight: 0 };
    if (cmd === "browser_action_dispatch") {
      inFlightEvaluates += 1;
      totalEvaluates += 1;
      maxConcurrentEvaluates = Math.max(maxConcurrentEvaluates, inFlightEvaluates);
      // Long enough that a burst of five agents MUST overlap if unthrottled.
      await new Promise((r) => setTimeout(r, 15));
      inFlightEvaluates -= 1;

      const { request_id, run_id, step_id, action } = args?.request as {
        request_id: string;
        run_id: string;
        step_id: string;
        action: { kind: string; roles?: string[]; target?: { name: string } };
      };
      const base = {
        schema_version: 1,
        type: "browser_action_result",
        request_id,
        run_id,
        step_id,
        completed_at: new Date().toISOString(),
      };
      if (action.kind === "list_controls") {
        return {
          ...base,
          outcome: "observed",
          observed: {
            resolved_name: "",
            match_count: 1,
            origin: ORIGIN,
            controls: [...pageFields.keys()].map((name) => ({
              role: "textbox",
              name,
              secure: false,
              editable: true,
              duplicate_count: 1,
            })),
          },
        };
      }
      const name = action.target?.name ?? "";
      if (action.kind === "read_field" && pageFields.has(name)) {
        return {
          ...base,
          outcome: "observed",
          observed: {
            value_after: pageFields.get(name),
            resolved_name: name,
            match_count: 1,
            origin: ORIGIN,
          },
        };
      }
      return {
        ...base,
        outcome: "refused",
        refusal_reason: "no_match",
        observed: { resolved_name: "", match_count: 0, origin: ORIGIN },
      };
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
const { bootAgentService, createAgentAndActivate, useAgentService, __resetAgentServiceForTests } =
  await import("../src/lib/agentService.js");
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

function firedContext() {
  return {
    source: "chrome_ext",
    app_category: "browser",
    event_type: "element_focused",
    target_role: "textbox",
    semantic_type: "phone",
    object_type: "contact",
    domain: "acme.example",
    occurred_at: new Date().toISOString(),
  };
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(async () => {
  agentsJson = null;
  listeners.length = 0;
  inFlightEvaluates = 0;
  maxConcurrentEvaluates = 0;
  totalEvaluates = 0;
  __resetAgentServiceForTests();
  useAgents.setState({ agents: [], hydrated: false, loadFailure: null, discarded: 0 });
  useSettings.setState((s) => ({
    settings: { ...s.settings, browser_actuation_origins: [ORIGIN] },
  }));
  await bootAgentService();
});

describe("autonomous shadow runs go through the worker pool", () => {
  it("five simultaneous firings never overlap more than the cap, and all five stage", async () => {
    // One real agent via the real create path…
    const created = await createAgentAndActivate(
      candidate(),
      "automate_record_workflow",
      "Fill the phone field.",
      "phone helper",
    );
    if (!created.ok) throw new Error(`create failed: ${created.message}`);

    // …cloned into five autonomy-granted agents in the persisted file, exactly
    // as five separately created agents would sit there.
    const file = JSON.parse(agentsJson!) as { agents: Array<Record<string, unknown>> };
    const original = file.agents[0]!;
    file.agents = Array.from({ length: 5 }, (_, i) => {
      const clone = structuredClone(original) as {
        agent_id: string;
        name: string;
        draft_autonomy: boolean;
        versions?: Array<{ spec?: { agent_id?: string; name?: string } }>;
      };
      const id = uuidv7();
      clone.agent_id = id;
      clone.name = `helper ${i + 1}`;
      clone.draft_autonomy = true;
      // The runtime registers by the SPEC's id — a clone that renames only the
      // record would collide with its siblings.
      for (const version of clone.versions ?? []) {
        if (version.spec) {
          version.spec.agent_id = id;
          version.spec.name = `helper ${i + 1}`;
        }
      }
      return clone;
    });
    agentsJson = JSON.stringify(file);

    // Restart onto the five-agent file.
    __resetAgentServiceForTests();
    listeners.length = 0;
    useAgents.setState({ agents: [], hydrated: false, loadFailure: null, discarded: 0 });
    await bootAgentService();
    maxConcurrentEvaluates = 0;
    totalEvaluates = 0;

    // The daemon announces all five at once — one live event, five triggers.
    const at = new Date().toISOString();
    const ids = useAgents.getState().agents.map((a) => a.agent_id);
    expect(ids).toHaveLength(5);
    await Promise.all(
      ids.map((agent_id, i) =>
        emitAppEvent({
          type: "agent_trigger_fired",
          firing: { agent_id, agent_name: `helper ${i + 1}`, at, context: firedContext() },
        }),
      ),
    );

    await waitFor(() => useAgentService.getState().staged.length === 5);

    // The pool actually ran page work…
    expect(totalEvaluates).toBeGreaterThan(0);
    // …but never more than the cap at once.
    expect(maxConcurrentEvaluates).toBeLessThanOrEqual(2);
    // Every agent reported an outcome — throttling must not turn into silence.
    const stagedIds = useAgentService.getState().staged.map((r) => r.agent_id);
    expect(new Set(stagedIds).size).toBe(5);
  });

  it("a duplicate firing for an agent already queued does not double-stage it", async () => {
    const created = await createAgentAndActivate(
      candidate(),
      "automate_record_workflow",
      "Fill the phone field.",
      "phone helper",
    );
    if (!created.ok) throw new Error(`create failed: ${created.message}`);
    useAgents.setState((s) => ({
      agents: s.agents.map((a) => ({ ...a, draft_autonomy: true })),
    }));

    const at = new Date().toISOString();
    const firing = {
      type: "agent_trigger_fired" as const,
      firing: {
        agent_id: created.agent_id,
        agent_name: "phone helper",
        at,
        context: firedContext(),
      },
    };
    await emitAppEvent(firing);
    await emitAppEvent(firing); // in flight → dropped, not queued behind itself
    await waitFor(() => useAgentService.getState().staged.length >= 1);
    // Give a would-be duplicate time to appear before asserting it did not.
    await new Promise((r) => setTimeout(r, 100));
    expect(useAgentService.getState().staged).toHaveLength(1);
  });
});
