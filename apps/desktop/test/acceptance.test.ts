/**
 * @vitest-environment jsdom
 *
 * jsdom because the actuator's PRESENCE GATE is real here: `userIsPresent`
 * fails closed without a document, and a consequential write is refused when
 * nobody is watching. The test runs with a visible document — the gate stays
 * in force rather than being mocked away.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runPatternEngine } from "@maman/pattern-engine";
import { uuidv7, type PatternCandidate, type PatternFeatureEvent } from "@maman/contracts";

/**
 * THE END-TO-END ACCEPTANCE TEST, one continuous chain:
 *
 *   user repeats a workflow 4× (feature events)
 *     → the REAL pattern engine detects it and produces a candidate
 *     → Create Agent (the same function the button calls)
 *     → compile → validate → persist → register → trigger installed → shadow
 *     → matching context fires → the agent is STAGED proactively
 *     → the user completes configuration (the value looking cannot reveal)
 *     → the exact proposed diff, hashed
 *     → approve → execute against the live (fake-protocol) page
 *     → independent readback verifies
 *     → the page actually changed
 *     → the same context again within cooldown → no duplicate
 *
 * Plus the stale-page abort: approve, page changes, execute → NOTHING written.
 *
 * Every cloud key is deleted before any of it runs. The page speaks the real
 * in-page protocol; the only thing missing versus production is a live window.
 */

delete process.env.OPENAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.GROQ_API_KEY;

const ORIGIN = "https://acme.example";
const OWNER = "018f0000-0000-7000-8000-0000000000aa";

let agentsJson: string | null = null;
const pageFields = new Map<string, string>([["Phone", "555-0100"]]);
type Listener = (e: unknown) => void;
const listeners: Listener[] = [];

vi.mock("../src/lib/bridge.js", () => ({
  isTauri: () => true,
  // Boot hydrates settings FIRST now — the persisted form is what counts.
  loadSettingsRaw: async () => JSON.stringify({ browser_actuation_origins: [ORIGIN] }),
  saveSettingsRaw: async () => {},
  invokeCommand: async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "agents_load") return agentsJson;
    if (cmd === "agents_save") {
      agentsJson = (args?.json as string) ?? null;
      return undefined;
    }
    if (cmd === "staged_runs_drain") return "[]";
    if (cmd === "browser_relay_status") return { connected: true, in_flight: 0 };
    // The signed Chrome relay — production's only browser transport. The page
    // answers `browser_action_dispatch` in the contract's raw result shape.
    if (cmd === "browser_action_dispatch") {
      const { request_id, run_id, step_id, action } = args?.request as {
        request_id: string;
        run_id: string;
        step_id: string;
        action: {
          kind: string;
          roles?: string[];
          target?: { name: string };
          value?: string;
          expect_current?: string;
        };
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
            match_count: pageFields.size,
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
      if (action.kind === "set_value" && pageFields.has(name)) {
        // Optimistic concurrency, exactly as the real page script enforces it.
        if (
          typeof action.expect_current === "string" &&
          pageFields.get(name) !== action.expect_current
        ) {
          return {
            ...base,
            outcome: "refused",
            refusal_reason: "precondition_failed",
            observed: { resolved_name: name, match_count: 1, origin: ORIGIN },
          };
        }
        const before = pageFields.get(name)!;
        pageFields.set(name, action.value ?? "");
        return {
          ...base,
          outcome: "applied",
          observed: {
            value_before: before,
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
const {
  bootAgentService,
  createAgentAndActivate,
  proposeForApproval,
  executeApproved,
  useAgentService,
  __resetAgentServiceForTests,
} = await import("../src/lib/agentService.js");
const { emitAppEvent } = await import("../src/lib/bridge.js");

const settled = () => new Promise((r) => setTimeout(r, 10));

/**
 * One repetition: open the record, focus the phone field, commit it, save.
 * Four events over ~45s — segmentation requires >=3 events and >=10s active,
 * because two clicks in five seconds is not a workflow.
 */
function rep(index: number, day: number): PatternFeatureEvent[] {
  const base = Date.parse("2026-08-04T09:00:00.000Z") + day * 86_400_000 + index * 600_000;
  const steps = [
    { event_type: "record_opened", target_role: "row" },
    { event_type: "element_focused", target_role: "textbox" },
    { event_type: "value_committed", target_role: "textbox" },
    { event_type: "value_committed", target_role: "textbox" },
  ] as const;
  return steps.map((step, i) => ({
    event_id: uuidv7(),
    occurred_at: new Date(base + i * 15_000).toISOString(),
    monotonic_ms: base + i * 15_000,
    source: "chrome",
    app_category: "browser",
    event_type: step.event_type,
    target_role: step.target_role,
    semantic_type: "phone",
    object_type: "contact",
    duration_ms: 15_000,
    sensitivity: "internal",
    excluded_from_learning: false,
  }));
}

beforeEach(async () => {
  agentsJson = null;
  listeners.length = 0;
  pageFields.set("Phone", "555-0100");
  __resetAgentServiceForTests();
  useAgents.setState({ agents: [], hydrated: false, loadFailure: null, discarded: 0 });
  useSettings.setState((s) => ({
    settings: { ...s.settings, browser_actuation_origins: [ORIGIN] },
  }));
  await bootAgentService();
});

/** Detection through the REAL engine — no hand-built candidate. */
function detect(): { candidate: PatternCandidate; intent: string } {
  const events = [rep(0, 0), rep(1, 0), rep(2, 1), rep(3, 1)].flat();
  const result = runPatternEngine(events, {
    owner_user_id: OWNER,
    now: () => new Date("2026-08-06T09:00:00.000Z"),
    // The tunable REPETITION bars, floored by the engine itself; the safety
    // bars (similarity, feasibility, risk) are not tunable and must pass as-is.
    eligibility: { min_occurrences: 3, min_distinct_days: 2, min_projected_minutes_weekly: 0 },
    // The OPPORTUNITY bar is a product-volume knob (the demo tuning screen
    // exposes it); four one-minute reps are a real pattern but a modest prize.
    // The SAFETY bars — similarity 1, feasibility 1, risk 0.5 here — pass at
    // their untunable defaults, which is the part that must not be loosened.
    opportunity_threshold: 0.4,
  });
  const candidate = result.candidates.find((c) => c.status === "eligible");
  if (!candidate) {
    throw new Error(
      `detection produced no eligible candidate: ${JSON.stringify(
        result.candidates.map((c) => ({
          status: c.status,
          n: c.occurrence_count,
          sim: c.similarity_mean,
          feas: c.feasibility_score,
          risk: c.risk_score,
          min: c.projected_minutes_saved_weekly,
        })),
      )} watching=${JSON.stringify(result.watching)}`,
    );
  }
  const recommendation = result.recommendations.find((r) => r.pattern_id === candidate.pattern_id);
  // The engine's OWN derived intent — nothing hand-picked. Optional on the
  // contract, and an absent intent must fail here rather than default: the
  // Suggestions handler refuses intent-less cards for the same reason.
  const intent = recommendation?.generalized_intent;
  if (!intent) throw new Error("an eligible candidate must carry a derived intent");
  return { candidate, intent };
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

describe("the whole loop, with no cloud key in the process", () => {
  it("repeats → detection → create → trigger → stage → configure → approve → write → readback → dedupe", async () => {
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();

    // 1. DETECTION, by the real engine over 4 repetitions.
    const { candidate, intent } = detect();
    expect(candidate.occurrence_count).toBeGreaterThanOrEqual(3);

    // 2. CREATE — the same function the button calls.
    const created = await createAgentAndActivate(
      candidate,
      intent,
      "Fill the phone field the way I always do.",
      "phone helper",
    );
    if (!created.ok) throw new Error(`create failed: ${created.message}`);
    expect(useAgents.getState().agents[0]!.state).toBe("shadow");

    // 3. PROACTIVE: matching context stages the agent. Nobody opened a screen.
    await emitAppEvent(matchingContext());
    await settled();
    expect(useAgentService.getState().staged).toHaveLength(1);

    // 4. CONFIGURE + PROPOSE: the user supplies the one thing looking cannot
    //    reveal, and gets back the EXACT diff with its hash.
    const proposal = await proposeForApproval(created.agent_id, { new_value: "555-0199" });
    if (!proposal.ok) throw new Error(`propose failed: ${proposal.detail}`);
    expect(proposal.diff.changes).toEqual([
      expect.objectContaining({ field: "Phone", old_value: "555-0100", new_value: "555-0199" }),
    ]);

    // 5. APPROVE → EXECUTE → READBACK.
    const outcome = await executeApproved(
      created.agent_id,
      { new_value: "555-0199" },
      proposal.sha,
    );
    if (outcome.status !== "completed") {
      throw new Error(`expected completed, got ${outcome.status}: ${JSON.stringify(outcome)}`);
    }
    expect(outcome.verified, outcome.verify_detail).toBe(true);
    expect(outcome.verify_detail).toContain("independent re-read confirmed");

    // 6. The page REALLY changed.
    expect(pageFields.get("Phone")).toBe("555-0199");

    // 7. The same context again, inside the cooldown: no duplicate staging.
    await emitAppEvent(matchingContext());
    await settled();
    expect(useAgentService.getState().staged).toHaveLength(1);
  });

  it("ABORTS the write when the page changed after approval, writing nothing", async () => {
    const { candidate, intent } = detect();
    const created = await createAgentAndActivate(candidate, intent, "Fill it.", "phone helper");
    if (!created.ok) throw new Error(`create failed: ${created.message}`);

    const proposal = await proposeForApproval(created.agent_id, { new_value: "555-0199" });
    if (!proposal.ok) throw new Error(`propose failed: ${proposal.detail}`);

    // Someone else edits the record between approval and execution.
    pageFields.set("Phone", "555-0777");

    const outcome = await executeApproved(
      created.agent_id,
      { new_value: "555-0199" },
      proposal.sha,
    );
    expect(outcome.status).toBe("aborted_stale");
    // NOTHING was written: not the approved value, and the intruding edit is
    // untouched — modifying a different value because the approved one no
    // longer exists is the exact outcome this refuses.
    expect(pageFields.get("Phone")).toBe("555-0777");
  });
});
