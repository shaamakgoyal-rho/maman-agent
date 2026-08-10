import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Stands in for the Rust persistence commands, so the DESKTOP path is what gets
 * tested rather than the web-preview localStorage fallback — the same approach
 * `learned-workflows.test.ts` takes.
 */
let storedJson: string | null = null;
/** Set to make the READ itself fail, which is a different case from bad bytes. */
let loadThrows = false;
vi.mock("../src/lib/bridge.js", () => ({
  isTauri: () => true,
  invokeCommand: async (cmd: string, args?: { json?: string }) => {
    if (cmd === "agents_load") {
      if (loadThrows) throw new Error("the agents file could not be opened");
      return storedJson;
    }
    if (cmd === "agents_save") {
      storedJson = args?.json ?? null;
      return undefined;
    }
    return undefined;
  },
  emitAppEvent: async () => undefined,
}));

const { AgentsNotLoadedError, parseAgentsFile, useAgents } = await import("../src/lib/agents.js");

/**
 * THE FILE IS THE USER'S AGENTS. LOSING IT IS NOT A LOGGING PROBLEM.
 *
 * Hydration was:
 *
 *     try {
 *       const raw = await loadRaw();
 *       if (raw) { ...if (parsed.success) { set(...); return; } }
 *     } catch { }                          // "defaults"
 *     set({ agents: [], hydrated: true });
 *
 * A read that threw, a file that was not JSON, and a file whose shape no longer
 * matched the schema all landed on the same line — an empty list marked
 * `hydrated`, indistinguishable from a first run. Six mutations then wrote that
 * empty list back through `saveRaw`, so the agents were not hidden, they were
 * destroyed on the next action.
 *
 * The schema-mismatch case is the one that would actually have happened: any
 * change to `agentRecordSchema` that is not backward-compatible wipes every
 * user's agents on upgrade.
 */

/** A minimal agent record that satisfies the real schema. */
function agentJson(id: string, name: string) {
  const spec = {
    schema_version: 1,
    agent_id: id,
    version_id: "018f0000-0000-7000-8000-0000000000b1",
    organization_id: "00000000-0000-7000-8000-000000000002",
    owner_user_id: "00000000-0000-7000-8000-000000000001",
    name,
    description: "d",
    generalized_intent: "reconcile_account_list",
    source_pattern_id: "018f0000-0000-7000-8000-0000000000c1",
    state: "draft",
    trigger: { type: "manual" },
    inputs: [],
    steps: [],
    assertions: [],
    budgets: {
      max_runtime_seconds: 300,
      max_model_tokens: 0,
      max_cost_usd: 1,
      max_records_read: 10,
      max_records_written: 1,
    },
    failure_policy: {
      on_assertion_failure: "stop",
      on_tool_failure: "stop",
      max_safe_retries: 0,
      approval_timeout_minutes: 60,
    },
    created_at: "2026-08-09T00:00:00.000Z",
    created_by: "compiler",
  };
  return {
    agent_id: id,
    name,
    state: "draft",
    versions: [
      {
        version_id: spec.version_id,
        version_number: 1,
        spec,
        plain_language_plan: [],
        intent_plan: [],
        created_at: spec.created_at,
        created_by: "compiler",
      },
    ],
    created_at: spec.created_at,
    server_agent_id: null,
    generalized_intent: "reconcile_account_list",
    desired_outcome: "o",
    approved_runs: 0,
    draft_autonomy: false,
  };
}

function writeFile(value: unknown): void {
  storedJson = typeof value === "string" ? value : JSON.stringify(value);
}

beforeEach(() => {
  storedJson = null;
  loadThrows = false;
  useAgents.setState({ agents: [], hydrated: false, loadFailure: null, discarded: 0 });
});

describe("reading the file tells the truth about what it found", () => {
  it("distinguishes a first run from a file it could not read", () => {
    expect(parseAgentsFile(null)).toEqual({ kind: "absent" });
    expect(parseAgentsFile("")).toEqual({ kind: "absent" });
    // Bytes that mean nothing to us are NOT "no agents yet".
    expect(parseAgentsFile("{not json").kind).toBe("unreadable");
    expect(parseAgentsFile('{"something":"else"}').kind).toBe("unreadable");
  });

  it("salvages the agents that still parse and counts the ones that do not", () => {
    const load = parseAgentsFile(
      JSON.stringify({
        schema_version: 1,
        agents: [
          agentJson("018f0000-0000-7000-8000-0000000000a1", "Keeps working"),
          { agent_id: "broken", shape: "from an older version" },
        ],
      }),
    );
    if (load.kind !== "loaded") throw new Error(`expected loaded, got ${load.kind}`);
    expect(load.agents.map((a) => a.name)).toEqual(["Keeps working"]);
    // Reported, not swallowed: "you have 1 agent" and "you have 1 and I dropped
    // 1" are different statements.
    expect(load.discarded).toBe(1);
  });
});

describe("a file that could not be read is never written over", () => {
  it("REFUSES to save, so the bytes on disk survive", async () => {
    const original = "{corrupted beyond parsing";
    writeFile(original);
    await useAgents.getState().hydrate();

    expect(useAgents.getState().loadFailure).not.toBeNull();
    expect(useAgents.getState().agents).toEqual([]);

    // Any mutation would previously have persisted the empty list.
    await expect(
      useAgents.getState().setState("018f0000-0000-7000-8000-0000000000a1", "paused"),
    ).rejects.toThrow(AgentsNotLoadedError);

    // The user's file is exactly as it was.
    expect(storedJson).toBe(original);
  });

  it("refuses just as firmly when the READ failed, not the parse", async () => {
    // The file may be perfectly intact and merely unreachable — a locked file,
    // a permissions problem. Reporting zero agents here is what made the next
    // save destroy a file that was never even opened.
    writeFile({
      schema_version: 1,
      agents: [agentJson("018f0000-0000-7000-8000-0000000000a1", "Mine")],
    });
    const intact = storedJson;
    loadThrows = true;

    await useAgents.getState().hydrate();
    expect(useAgents.getState().loadFailure).toContain("could not be opened");

    await expect(
      useAgents.getState().setState("018f0000-0000-7000-8000-0000000000a1", "paused"),
    ).rejects.toThrow(AgentsNotLoadedError);
    expect(storedJson).toBe(intact);
  });

  it("says what it will not do, and that nothing was lost", async () => {
    writeFile("{corrupted");
    await useAgents.getState().hydrate();
    const error = await useAgents
      .getState()
      .setState("018f0000-0000-7000-8000-0000000000a1", "paused")
      .then(() => null)
      .catch((e: unknown) => e);
    if (!(error instanceof AgentsNotLoadedError)) throw new Error("expected a refusal");
    expect(error.message).toContain("will not save over that file");
    expect(error.message).toContain("The file is untouched.");
  });

  it("treats a genuine first run as writable, not as a failure", async () => {
    // `absent` must not set `loadFailure`, or a new user could never create
    // their first agent — the refusal would lock the app for everyone.
    await useAgents.getState().hydrate();
    expect(useAgents.getState().loadFailure).toBeNull();
    expect(useAgents.getState().agents).toEqual([]);
  });

  it("saves normally when the file loaded cleanly", async () => {
    writeFile({
      schema_version: 1,
      agents: [agentJson("018f0000-0000-7000-8000-0000000000a1", "Mine")],
    });
    await useAgents.getState().hydrate();
    expect(useAgents.getState().agents.map((a) => a.name)).toEqual(["Mine"]);

    await expect(
      useAgents.getState().setState("018f0000-0000-7000-8000-0000000000a1", "paused"),
    ).resolves.not.toThrow();
    expect(storedJson).toContain('"state":"paused"');
  });

  it("saves normally after a partial-salvage load", async () => {
    // Some records were dropped, but the file WAS understood — refusing to
    // write here would strand the user with an app that cannot change anything.
    writeFile({
      schema_version: 1,
      agents: [agentJson("018f0000-0000-7000-8000-0000000000a1", "Good"), { agent_id: "broken" }],
    });
    await useAgents.getState().hydrate();
    expect(useAgents.getState().loadFailure).toBeNull();
    expect(useAgents.getState().discarded).toBe(1);
    await expect(
      useAgents.getState().setState("018f0000-0000-7000-8000-0000000000a1", "paused"),
    ).resolves.not.toThrow();
  });
});

describe("the schema-drift case that would really have happened", () => {
  it("does not silently present a drifted file as an empty account", async () => {
    // Every version record missing a field the schema requires: previously this
    // hydrated to zero agents and the next save destroyed the file.
    const drifted = agentJson("018f0000-0000-7000-8000-0000000000a1", "Mine") as Record<
      string,
      unknown
    >;
    delete (drifted.versions as Record<string, unknown>[])[0]!.plain_language_plan;
    writeFile({ schema_version: 1, agents: [drifted] });

    await useAgents.getState().hydrate();
    const state = useAgents.getState();
    // Salvage dropped it, but the drop is COUNTED and the file stays writable
    // only because the file itself was understood.
    expect(state.agents).toEqual([]);
    expect(state.discarded).toBe(1);
  });
});
