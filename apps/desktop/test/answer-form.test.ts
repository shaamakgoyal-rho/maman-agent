import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PatternCandidate } from "@maman/contracts";

/**
 * THE ONE QUESTION.
 *
 * The agent finds its own field by looking at the page. It cannot find the
 * VALUE — that is in a person's head — so a write agent has to ask for exactly
 * one thing, and only after it has resolved everything else for itself.
 *
 * These tests pin the gate that asks: it appears only when the gap is genuinely
 * the user's to close, it carries the plan so the answer is given for a stated
 * purpose, and it refuses a credential before that credential can be typed into
 * a page.
 */

const ORIGIN = "https://acme.example";

/** A page with one obvious phone field, driven through the real page script. */
const evaluate = vi.fn(async (expression: string) => {
  const marker = "})(";
  const literal = expression.slice(expression.lastIndexOf(marker) + marker.length, -1);
  const { request_id, action } = JSON.parse(JSON.parse(literal) as string) as {
    request_id: string;
    action: { kind: string; roles?: string[]; target?: { name: string }; value?: string };
  };
  if (action.kind === "list_controls") {
    return JSON.stringify({
      request_id,
      outcome: "observed",
      observed: {
        accessible_name: "",
        match_count: 1,
        controls: [
          { role: "textbox", name: "Phone", secure: false, editable: true, duplicate_count: 1 },
        ],
      },
    });
  }
  if (action.kind === "read_field") {
    return JSON.stringify({
      request_id,
      outcome: "observed",
      observed: { value_after: "555-0100", accessible_name: "Phone", match_count: 1 },
    });
  }
  return JSON.stringify({ request_id, outcome: "failed", detail: "unsupported" });
});

vi.mock("../src/lib/agentBrowser.js", () => ({
  tauriAgentBrowserHost: () => ({
    navigate: async () => undefined,
    currentOrigin: async () => ORIGIN,
    evaluate,
  }),
  closeAgentBrowser: async () => undefined,
}));

const { useRuns, checkAnswer } = await import("../src/lib/runs.js");

/** An observed browser workflow that ends in a real edit — so it writes. */
function candidate(): PatternCandidate {
  return {
    pattern_id: "018f0000-0000-7000-8000-0000000000d1",
    owner_user_id: "018f0000-0000-7000-8000-0000000000aa",
    first_seen_at: "2026-08-01T09:00:00.000Z",
    last_seen_at: "2026-08-02T09:00:00.000Z",
    occurrence_count: 12,
    distinct_day_count: 4,
    median_duration_ms: 30_000,
    p90_duration_ms: 45_000,
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
const OUTCOME = "Fill the field I fill on this page.";

beforeEach(() => {
  useRuns.getState().reset();
  useRuns.getState().setLane("browser", [ORIGIN]);
  evaluate.mockClear();
});

describe("what the user is asked", () => {
  it("asks for the value, and NOT for the field it found itself", async () => {
    await useRuns.getState().startShadow(candidate(), INTENT, OUTCOME, "phone helper");
    const state = useRuns.getState();

    expect(state.phase).toBe("needs_input");
    expect(state.questions).toHaveLength(1);
    // Concrete: it already knows which control, so the question names it.
    expect(state.questions[0]).toMatchObject({
      slot: "new_value",
      prompt: "What should “Phone” say?",
    });
    // The field is never asked about — the agent went and looked.
    expect(state.questions.some((q) => q.slot === "field")).toBe(false);
  });

  it("shows the plan the answer would authorise", async () => {
    // A bare input box asks for a value without saying what it is for.
    await useRuns.getState().startShadow(candidate(), INTENT, OUTCOME, "phone helper");
    const plan = useRuns.getState().questionPlan;
    expect(plan.some((l) => l.includes("“Phone”"))).toBe(true);
    expect(plan.filter((l) => /only write/.test(l))).toHaveLength(1);
  });

  it("is a question, not a failure", async () => {
    // `failed` would put a red error in front of someone when nothing went
    // wrong — the agent did its half and is waiting on theirs.
    await useRuns.getState().startShadow(candidate(), INTENT, OUTCOME, "phone helper");
    expect(useRuns.getState().phase).not.toBe("failed");
    expect(useRuns.getState().error).toBeNull();
  });

  it("writes nothing while it waits", async () => {
    await useRuns.getState().startShadow(candidate(), INTENT, OUTCOME, "phone helper");
    const kinds = evaluate.mock.calls.map(([expression]) => {
      const marker = "})(";
      const literal = expression.slice(expression.lastIndexOf(marker) + marker.length, -1);
      return (JSON.parse(JSON.parse(literal) as string) as { action: { kind: string } }).action
        .kind;
    });
    expect(kinds).toEqual(["list_controls"]);
    expect(kinds).not.toContain("set_value");
  });
});

describe("the answer is checked before it can reach a page", () => {
  it("REFUSES a credential, and says why", () => {
    // This value gets typed into a field, relayed over the native channel, and
    // recorded on the receipt — three places secret material is never allowed.
    const refusal = checkAnswer(`ghp_${"a".repeat(36)}`);
    expect(refusal).toMatchObject({ ok: false });
    if (refusal.ok) throw new Error("unreachable");
    expect(refusal.reason).toMatch(/never types secrets/);
  });

  it("refuses an empty answer and one longer than a field holds", () => {
    expect(checkAnswer("   ").ok).toBe(false);
    expect(checkAnswer("x".repeat(513)).ok).toBe(false);
  });

  it("accepts an ordinary value", () => {
    expect(checkAnswer("555-0199").ok).toBe(true);
  });

  it("does not restart the run on a refused answer", async () => {
    await useRuns.getState().startShadow(candidate(), INTENT, OUTCOME, "phone helper");
    evaluate.mockClear();

    await useRuns.getState().answer({ new_value: `ghp_${"a".repeat(36)}` });

    const state = useRuns.getState();
    expect(state.phase).toBe("needs_input");
    expect(state.error).toMatch(/never types secrets/);
    // Nothing was dispatched: the refusal happened before the page was touched.
    expect(evaluate).not.toHaveBeenCalled();
  });
});

describe("answering continues the run", () => {
  it("resolves and proceeds past the question", async () => {
    await useRuns.getState().startShadow(candidate(), INTENT, OUTCOME, "phone helper");
    expect(useRuns.getState().phase).toBe("needs_input");

    await useRuns.getState().answer({ new_value: "555-0199" });

    const state = useRuns.getState();
    // Asserted as COMPLETED, not merely "no longer asking". `not.toBe(
    // "needs_input")` also passes on a failed run, and it did: the verify step
    // had no fields bound and threw the very "teach the workflow which fields
    // matter first" error this whole path removes.
    expect(state.phase, state.error ?? "").toBe("completed");
    expect(state.error).toBeNull();
    expect(state.questions).toEqual([]);
    // The proposal names the discovered field and the answered value.
    expect(state.diff?.changes[0]).toMatchObject({
      field: "Phone",
      old_value: "555-0100",
      new_value: "555-0199",
    });
  });

  it("LOOKS AGAIN rather than trusting the page as it was when it asked", async () => {
    // The box may have been open for minutes. Acting on the surface as it was
    // when the question appeared is how a stale target gets written to.
    await useRuns.getState().startShadow(candidate(), INTENT, OUTCOME, "phone helper");
    evaluate.mockClear();

    await useRuns.getState().answer({ new_value: "555-0199" });

    const listed = evaluate.mock.calls.filter(([expression]) =>
      expression.includes("list_controls"),
    );
    expect(listed.length).toBeGreaterThan(0);
  });

  it("does not carry the answer into the next run", async () => {
    // An answer given for one run is not a standing instruction to write that
    // value every time.
    await useRuns.getState().startShadow(candidate(), INTENT, OUTCOME, "phone helper");
    await useRuns.getState().answer({ new_value: "555-0199" });
    useRuns.getState().reset();

    await useRuns.getState().startShadow(candidate(), INTENT, OUTCOME, "phone helper");
    expect(useRuns.getState().phase).toBe("needs_input");
  });
});
