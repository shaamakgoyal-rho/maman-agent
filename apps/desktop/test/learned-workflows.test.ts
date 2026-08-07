import { describe, expect, it, vi } from "vitest";
import { learnedWorkflowSchema, workflowReadiness, type PatternCandidate } from "@maman/contracts";

/** Stands in for the Rust persistence commands, so the DESKTOP path is what
 * gets tested rather than the web-preview localStorage fallback. */
let storedJson: string | null = null;
vi.mock("../src/lib/bridge.js", () => ({
  isTauri: () => true,
  invokeCommand: async (cmd: string, args?: { json?: string }) => {
    if (cmd === "learned_workflows_load") return storedJson;
    if (cmd === "learned_workflows_save") {
      storedJson = args?.json ?? null;
      return undefined;
    }
    return undefined;
  },
  emitAppEvent: async () => undefined,
}));

const { draftFromCandidate, applyEdit, parseWorkflowsFile } =
  await import("../src/lib/learnedWorkflows.js");

/**
 * Seeding a teach session from an observed pattern.
 *
 * The property under test is a NEGATIVE one, and it is the whole reason this
 * layer exists: the draft must carry over what was observed and nothing more.
 * Every previous attempt to be helpful here — inferring a target from a role,
 * a value from a semantic type — produced a workflow the user had not described
 * and could then approve without noticing.
 */

const OWNER = "019fc4d0-130f-706e-b94e-42a86e9b3815";
const PATTERN = "019fc4d0-130f-706e-b94e-42a86e9b3812";

/** The live device's pattern: a focus and two value changes, no nouns. */
function candidate(
  sequence: string[] = [
    "macos_ax:browser:element_focused:AXGroup:-:-",
    "macos_ax:browser:value_committed:AXTextField:-:-",
  ],
): PatternCandidate {
  return {
    pattern_id: PATTERN,
    owner_user_id: OWNER,
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

const at = () => new Date("2026-08-07T12:00:00.000Z");

describe("a draft carries over what was observed, and nothing more", () => {
  it("produces a valid record that is NOT ready", () => {
    const draft = draftFromCandidate(candidate(), OWNER, at);
    expect(() => learnedWorkflowSchema.parse(draft)).not.toThrow();
    expect(workflowReadiness(draft).ready).toBe(false);
  });

  it("leaves every target EMPTY, because none was observable", () => {
    // The observer records that a text field changed. It never records which.
    const draft = draftFromCandidate(candidate(), OWNER, at);
    expect(draft.steps.length).toBeGreaterThan(0);
    expect(draft.steps.every((s) => s.target === undefined)).toBe(true);
  });

  it("leaves every value EMPTY, because values are never recorded at all", () => {
    const draft = draftFromCandidate(candidate(), OWNER, at);
    expect(draft.steps.every((s) => s.value === undefined)).toBe(true);
  });

  it("allows no origin until the user names one", () => {
    const draft = draftFromCandidate(candidate(), OWNER, at);
    expect(draft.allowed_origins).toEqual([]);
  });

  it("NAMES what is missing, per step, rather than saying 'needs configuration'", () => {
    const draft = draftFromCandidate(candidate(), OWNER, at);
    const kinds = draft.missing_configuration.map((m) => m.kind);
    expect(kinds).toContain("origin");
    expect(kinds).toContain("target");
    // Step-specific gaps carry the step they belong to.
    const targetGaps = draft.missing_configuration.filter((m) => m.kind === "target");
    expect(targetGaps.every((m) => typeof m.step_id === "string")).toBe(true);
  });

  it("marks provenance as observed, not user_configured", () => {
    // Nothing has been confirmed yet; claiming otherwise would misrepresent how
    // much of this the user actually chose.
    expect(draftFromCandidate(candidate(), OWNER, at).provenance).toBe("observed");
  });

  it("links back to the pattern it came from", () => {
    expect(draftFromCandidate(candidate(), OWNER, at).source_pattern_id).toBe(PATTERN);
  });

  it("includes only steps a helper could actually perform", () => {
    // An app switch is context, not work — it must not become a configurable
    // step the user is asked to describe.
    const draft = draftFromCandidate(
      candidate([
        "macos_ax:browser:app_activated:-:-:-",
        "macos_ax:browser:value_committed:AXTextField:-:-",
      ]),
      OWNER,
      at,
    );
    expect(draft.steps).toHaveLength(1);
  });
});

describe("editing re-derives what is still missing", () => {
  it("clears a gap once the user answers it", () => {
    const draft = draftFromCandidate(candidate(), OWNER, at);
    const configured = applyEdit(
      draft,
      {
        allowed_origins: ["https://acme.example"],
        steps: draft.steps.map((s) => ({
          ...s,
          target: { role: "textbox" as const, name: "Phone" },
          ...(s.mode === "read" ? {} : { value: { kind: "constant" as const, value: "555-0199" } }),
        })),
      },
      at,
    );
    expect(workflowReadiness(configured).ready).toBe(true);
    expect(configured.missing_configuration).toEqual([]);
  });

  it("a partial answer leaves the REST of the gaps in place", () => {
    // Hand-clearing would let an incomplete workflow compile; this re-derives.
    const draft = draftFromCandidate(candidate(), OWNER, at);
    const partial = applyEdit(draft, { allowed_origins: ["https://acme.example"] }, at);
    expect(workflowReadiness(partial).ready).toBe(false);
    expect(partial.missing_configuration.some((m) => m.kind === "target")).toBe(true);
    // …and the answered one is gone.
    expect(partial.missing_configuration.some((m) => m.kind === "origin")).toBe(false);
  });

  it("bumps the version on every material edit", () => {
    // A compiled agent names the exact version it was built from, so an edit
    // that did not bump would make two different plans share an identity.
    const draft = draftFromCandidate(candidate(), OWNER, at);
    expect(applyEdit(draft, { name: "Renamed" }, at).version).toBe(draft.version + 1);
  });

  it("records that the user configured it once they have edited", () => {
    const draft = draftFromCandidate(candidate(), OWNER, at);
    expect(applyEdit(draft, { name: "Mine" }, at).provenance).toBe("user_configured");
  });
});

describe("the store loads what was persisted", () => {
  it("hydrate() surfaces workflows written by an earlier session", async () => {
    // The panel must call this on start. Without it the store begins empty and
    // a workflow the user taught yesterday reads as "not found" — their
    // configuration silently invisible until a save overwrote it.
    const { useLearnedWorkflows } = await import("../src/lib/learnedWorkflows.js");
    const draft = draftFromCandidate(candidate(), OWNER, at);
    storedJson = JSON.stringify({ schema_version: 1, workflows: [draft] });
    await useLearnedWorkflows.getState().hydrate();
    expect(useLearnedWorkflows.getState().workflows.map((w) => w.workflow_id)).toEqual([
      draft.workflow_id,
    ]);
    expect(useLearnedWorkflows.getState().hydrated).toBe(true);
  });

  it("an absent file hydrates to an empty list, not an error state", async () => {
    const { useLearnedWorkflows } = await import("../src/lib/learnedWorkflows.js");
    storedJson = null;
    await useLearnedWorkflows.getState().hydrate();
    expect(useLearnedWorkflows.getState().workflows).toEqual([]);
    expect(useLearnedWorkflows.getState().hydrated).toBe(true);
  });
});

describe("reading the persisted file", () => {
  const good = () =>
    applyEdit(
      draftFromCandidate(candidate(), OWNER, at),
      {
        allowed_origins: ["https://acme.example"],
        steps: draftFromCandidate(candidate(), OWNER, at).steps.map((s) => ({
          ...s,
          target: { role: "textbox" as const, name: "Phone" },
          ...(s.mode === "read" ? {} : { value: { kind: "constant" as const, value: "x" } }),
        })),
      },
      at,
    );

  it("reads back what was written", () => {
    const raw = JSON.stringify({ schema_version: 1, workflows: [good()] });
    expect(parseWorkflowsFile(raw).workflows).toHaveLength(1);
  });

  it("returns nothing for an absent or unreadable file, without throwing", () => {
    expect(parseWorkflowsFile(null).workflows).toEqual([]);
    expect(parseWorkflowsFile("not json").workflows).toEqual([]);
  });

  it("SALVAGES the good records when one is corrupt, and counts the loss", () => {
    // One bad workflow must not cost the user everything else they taught.
    const raw = JSON.stringify({
      schema_version: 1,
      workflows: [good(), { workflow_id: "not-a-uuid", nonsense: true }],
    });
    const parsed = parseWorkflowsFile(raw);
    expect(parsed.workflows).toHaveLength(1);
    expect(parsed.discarded).toBe(1);
  });

  it("does NOT coerce a half-parsed record into something the user did not configure", () => {
    // A repaired-by-guessing workflow is exactly what would compile into an
    // agent doing not-quite-what-was-asked.
    const raw = JSON.stringify({
      schema_version: 1,
      workflows: [{ ...good(), steps: [{ step_id: "x", order: 1 }] }],
    });
    const parsed = parseWorkflowsFile(raw);
    expect(parsed.workflows).toHaveLength(0);
    expect(parsed.discarded).toBe(1);
  });
});
