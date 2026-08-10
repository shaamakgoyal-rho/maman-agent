import { create } from "zustand";
import { z } from "zod";
import {
  agentSpecSchema,
  patternCandidateSchema,
  uuidv7,
  type AgentSpec,
  type PatternCandidate,
} from "@maman/contracts";
import {
  compileAgentSpec,
  demoAdapterRegistry,
  DemoSalesforceWorld,
  renderPlainLanguagePlan,
  runtimeFromRegistry,
  stateAfterMaterialEdit,
  validateAgentSpec,
  type MissingCapability,
  type MissingConfiguration,
} from "@maman/agent-runtime";
import { DEFAULT_ORG_POLICY } from "@maman/policy-engine";
import { DemoModelProvider } from "@maman/model-provider";
import { emitAppEvent, invokeCommand, isTauri } from "./bridge.js";

/**
 * Local agent store (demo/local mode; server persistence joins at M7).
 * Versions are immutable: any material edit appends a new version and returns
 * the agent to shadow. Nothing here ever executes — runs arrive with M7.
 */

const versionSchema = z
  .object({
    version_id: z.string(),
    version_number: z.number().int().positive(),
    spec: agentSpecSchema,
    plain_language_plan: z.array(z.string()),
    /**
     * The intent-derived plan: what this agent does on the real surface, in
     * the user's terms. Defaulted rather than required so agents written by an
     * earlier build still load — an empty plan renders nothing, which is the
     * correct treatment for an agent whose steps no intent claimed.
     */
    intent_plan: z.array(z.string()).default([]),
    created_at: z.string(),
    created_by: z.enum(["user", "compiler"]),
  })
  .strict();

const agentRecordSchema = z
  .object({
    agent_id: z.string(),
    name: z.string(),
    state: z.enum([
      "draft",
      "shadow",
      "supervised",
      "active",
      "paused",
      "degraded",
      "revoked",
      "archived",
    ]),
    versions: z.array(versionSchema).min(1),
    created_at: z.string(),
    // M18: once registered on the Maman server, the server-side agent id so
    // runs can target the durable server path. Null in local-only mode.
    server_agent_id: z.string().nullable().default(null),
    // Compile inputs, kept so the agent can be (re)compiled server-side.
    generalized_intent: z.string().default("reconcile_account_list"),
    desired_outcome: z.string().default("Reconcile the account list with Salesforce."),
    // Earned autonomy: approved supervised runs accumulate per workflow. When
    // the count reaches the settings threshold the WORKER may grant draft
    // autonomy — a match record makes the offer possible; only the worker's
    // explicit grant changes anything. Never auto-promoted.
    approved_runs: z.number().int().nonnegative().default(0),
    draft_autonomy: z.boolean().default(false),
    // The REAL detected candidate this agent was compiled from, so reruns
    // recompile from the same evidence. Older records lack it and fall back
    // to a minimal stand-in (Agents.tsx candidateFor).
    source_candidate: patternCandidateSchema.optional(),
  })
  .strict();

const agentsFileSchema = z
  .object({
    schema_version: z.literal(1).default(1),
    agents: z.array(agentRecordSchema).default([]),
  })
  .strict();

export type AgentRecord = z.infer<typeof agentRecordSchema>;
export type AgentVersion = z.infer<typeof versionSchema>;

async function loadRaw(): Promise<string | null> {
  if (isTauri()) return invokeCommand<string | null>("agents_load");
  return localStorage.getItem("maman-agents");
}
async function saveRaw(json: string): Promise<void> {
  if (isTauri()) {
    await invokeCommand("agents_save", { json });
    return;
  }
  localStorage.setItem("maman-agents", json);
}

/**
 * What reading the agents file actually produced.
 *
 * `absent` and `unreadable` used to be the same thing. Hydration was:
 *
 *     try {
 *       const raw = await loadRaw();
 *       if (raw) { ...if (parsed.success) { set(...); return; } }
 *     } catch { }             // "defaults"
 *     set({ agents: [], hydrated: true });
 *
 * A read that threw, a file that was not JSON, and a file whose SHAPE no longer
 * matched the schema all arrived at the same line: an empty agent list,
 * `hydrated: true`, indistinguishable from a first run. The six mutations below
 * then write the in-memory array back with `saveRaw`, so the user's agents were
 * not merely hidden — the next action destroyed them on disk.
 *
 * The third case is the realistic one. Any schema change that is not
 * backward-compatible wipes every existing user's agents on upgrade. This
 * session added `intent_plan` to `versionSchema` with `.default([])`, which
 * kept old files loadable — but nothing enforced that care, and nothing would
 * have reported it if the care had been missing.
 */
/** Thrown instead of writing over a file whose contents we never understood. */
export class AgentsNotLoadedError extends Error {
  constructor(detail: string) {
    super(
      `I could not read your saved agents (${detail}), so I will not save over that file — doing so would replace it with an empty list. The file is untouched.`,
    );
    this.name = "AgentsNotLoadedError";
  }
}

export type AgentsLoad =
  | { kind: "absent" }
  | { kind: "unreadable"; detail: string }
  | { kind: "loaded"; agents: AgentRecord[]; discarded: number };

/**
 * Parses the file, salvaging what it can.
 *
 * Per-record salvage mirrors `parseWorkflowsFile`: one agent whose shape has
 * drifted must not cost the user the rest. The count is returned rather than
 * swallowed, because "you have 3 agents" and "you have 3 agents and I dropped
 * 2" are different statements.
 */
export function parseAgentsFile(raw: string | null): AgentsLoad {
  if (raw === null || raw.trim() === "") return { kind: "absent" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    // NOT `absent`. There are bytes here that we could not understand, and
    // treating them as "no agents yet" is what licensed overwriting them.
    return { kind: "unreadable", detail: e instanceof Error ? e.message : "not valid JSON" };
  }

  const whole = agentsFileSchema.safeParse(parsed);
  if (whole.success) return { kind: "loaded", agents: whole.data.agents, discarded: 0 };

  const list = (parsed as { agents?: unknown }).agents;
  if (!Array.isArray(list)) {
    return { kind: "unreadable", detail: "the file has no agents list" };
  }
  const agents: AgentRecord[] = [];
  let discarded = 0;
  for (const item of list) {
    const one = agentRecordSchema.safeParse(item);
    if (one.success) agents.push(one.data);
    else discarded += 1;
  }
  return { kind: "loaded", agents, discarded };
}

export type CreateDraftResult =
  | { ok: true; agent: AgentRecord; policy_summary: string }
  | {
      ok: false;
      message: string;
      /**
       * Present when the refusal was a runtime gap rather than an unknown
       * workflow — the UI can then tell the user what to connect or install
       * instead of asking them to describe the workflow differently.
       */
      missing_capabilities?: MissingCapability[];
      /**
       * Present when the workflow needs to be TAUGHT: the typed list of what
       * observation could not learn (data source, field mapping, …).
       */
      missing_configuration?: MissingConfiguration[];
    };

type AgentsStore = {
  agents: AgentRecord[];
  hydrated: boolean;
  /**
   * Set when the file existed but could not be understood. While this is set
   * the store REFUSES to write, because saving the (empty) in-memory list would
   * replace whatever is on disk with nothing.
   */
  loadFailure: string | null;
  /** Agents whose shape no longer parses. Reported, never silently dropped. */
  discarded: number;
  hydrate: () => Promise<void>;
  createDraft: (
    candidate: PatternCandidate,
    generalizedIntent: string,
    desiredOutcome: string,
    /** The exact workflow name the card showed — becomes the agent's name. */
    displayName?: string,
  ) => Promise<CreateDraftResult>;
  /** Material edit: new immutable version; agent returns to shadow. */
  editDescription: (agentId: string, description: string) => Promise<boolean>;
  setState: (agentId: string, state: AgentRecord["state"]) => Promise<void>;
  /**
   * Registers the agent on the Maman server (M18): compiles the candidate
   * server-side (so the configured model provider runs on the server) and
   * persists the spec. Returns the server agent id. Idempotent per candidate —
   * a repeat call reuses the stored server agent id. All HTTP originates in the
   * Rust core with the keychain device token.
   */
  registerOnServer: (
    agentId: string,
    candidate: PatternCandidate,
  ) => Promise<{ ok: true; server_agent_id: string } | { ok: false; message: string }>;
  /** Records one approved, completed supervised run (the autonomy meter). */
  recordApprovedRun: (agentId: string) => Promise<void>;
  /**
   * WORKER-granted draft autonomy. Only enabled once approved_runs reaches the
   * settings threshold; a match record never auto-promotes anything.
   */
  grantDraftAutonomy: (agentId: string) => Promise<void>;
};

/**
 * The single write path, so the refusal cannot be forgotten at one of six
 * call sites. Each of those previously inlined
 * `saveRaw(JSON.stringify(agentsFileSchema.parse(...)))`, and any one of them
 * reached after a failed load would have overwritten the file.
 */
async function persist(agents: AgentRecord[]): Promise<void> {
  const failure = useAgents.getState().loadFailure;
  if (failure !== null) throw new AgentsNotLoadedError(failure);
  await saveRaw(JSON.stringify(agentsFileSchema.parse({ schema_version: 1, agents })));
}

export const useAgents = create<AgentsStore>((set, get) => ({
  agents: [],
  hydrated: false,
  loadFailure: null,
  discarded: 0,

  hydrate: async () => {
    let raw: string | null;
    try {
      raw = await loadRaw();
    } catch (e) {
      // The read itself failed — the file may be perfectly intact and simply
      // unreachable. Reporting zero agents here is what made the next save
      // destroy them.
      set({
        agents: [],
        hydrated: true,
        loadFailure: e instanceof Error ? e.message : "could not read the agents file",
        discarded: 0,
      });
      return;
    }

    const load = parseAgentsFile(raw);
    if (load.kind === "unreadable") {
      set({ agents: [], hydrated: true, loadFailure: load.detail, discarded: 0 });
      return;
    }
    if (load.kind === "absent") {
      set({ agents: [], hydrated: true, loadFailure: null, discarded: 0 });
      return;
    }
    set({
      agents: load.agents,
      hydrated: true,
      loadFailure: null,
      discarded: load.discarded,
    });
  },

  createDraft: async (candidate, generalizedIntent, desiredOutcome, displayName) => {
    await emitAppEvent({
      type: "status_beat",
      beat: { kind: "creating_agent", title: displayName ?? "a new helper" },
    });
    const result = await compileAgentSpec({
      candidate,
      generalized_intent: generalizedIntent,
      desired_outcome: desiredOutcome,
      organization_id: "00000000-0000-7000-8000-000000000002",
      owner_user_id: "00000000-0000-7000-8000-000000000001",
      budgets: {
        max_runtime_seconds: 300,
        max_model_tokens: 12_000,
        max_cost_usd: 1,
        max_records_read: 1000,
        max_records_written: 20,
      },
      policy: DEFAULT_ORG_POLICY,
      policy_version_id: uuidv7(),
      now: () => new Date(),
      model: new DemoModelProvider(),
      // Compile for the runtime that will actually run it, so a helper is never
      // created from steps this device cannot execute.
      runtime: runtimeFromRegistry("local-demo", demoAdapterRegistry(new DemoSalesforceWorld())),
    });

    // `needs_runtime` is a DIFFERENT answer from `blocked`: the workflow is
    // understood, but this runtime has no adapter (or an unmet prerequisite) for
    // one of its steps. Registering it anyway is what let a spec containing
    // browser.supervised_form_fill — which no registry implements — reach the
    // run engine as an `undefined` adapter.
    if (result.status !== "valid") {
      const message =
        result.status === "needs_runtime"
          ? `${result.message}. I won't create a helper that can't run.`
          : result.message;
      await emitAppEvent({
        type: "status_beat",
        beat: {
          kind: "agent_failed",
          title: displayName ?? "a new helper",
          message,
        },
      });
      return {
        ok: false,
        message,
        ...(result.status === "needs_runtime" ? { missing_capabilities: result.missing } : {}),
        // Typed teach-me list: what observation could not learn. The Teach
        // flow (Phase 2) consumes this; until then the card shows the details.
        ...(result.status === "needs_configuration"
          ? { missing_configuration: result.missing }
          : {}),
      };
    }

    const agent: AgentRecord = {
      agent_id: result.spec.agent_id,
      // Named after the exact workflow it automates (the card's title), not
      // the compiler's generic copy.
      name: displayName ?? result.spec.name,
      state: "draft", // never silently active
      versions: [
        {
          version_id: result.spec.version_id,
          version_number: 1,
          spec: result.spec,
          plain_language_plan: result.plain_language_plan,
          intent_plan: result.intent_plan,
          created_at: result.spec.created_at,
          created_by: "compiler",
        },
      ],
      created_at: result.spec.created_at,
      source_candidate: candidate,
      server_agent_id: null,
      generalized_intent: generalizedIntent,
      desired_outcome: desiredOutcome,
      approved_runs: 0,
      draft_autonomy: false,
    };
    const agents = [...get().agents.filter((a) => a.agent_id !== agent.agent_id), agent];
    await persist(agents);
    set({ agents });
    await emitAppEvent({
      type: "status_beat",
      beat: { kind: "agent_ready", title: agent.name },
    });
    return {
      ok: true,
      agent,
      policy_summary:
        result.policy_decision.decision === "require_approval"
          ? "Material writes will pause for your approval on every run."
          : "This draft is fully read-only.",
    };
  },

  editDescription: async (agentId, description) => {
    const agents = [...get().agents];
    const agent = agents.find((a) => a.agent_id === agentId);
    if (!agent) return false;
    const latest = agent.versions[agent.versions.length - 1]!;
    const newSpec: AgentSpec = {
      ...latest.spec,
      description,
      version_id: uuidv7(),
      state: stateAfterMaterialEdit(agent.state),
    };
    const validation = validateAgentSpec(newSpec);
    if (!validation.valid) return false;
    agent.versions = [
      ...agent.versions,
      {
        version_id: newSpec.version_id,
        version_number: latest.version_number + 1,
        spec: validation.spec,
        plain_language_plan: renderPlainLanguagePlan(validation.spec),
        // Editing the description does not change a step, so the plan of what
        // the agent does carries forward untouched. Re-deriving it here would
        // be wrong in the other direction: it would silently overwrite what
        // the user was shown when they approved.
        intent_plan: latest.intent_plan,
        created_at: new Date().toISOString(),
        created_by: "user",
      },
    ];
    // Material edit returns the agent to shadow.
    agent.state = stateAfterMaterialEdit(agent.state);
    await persist(agents);
    set({ agents });
    return true;
  },

  setState: async (agentId, state) => {
    const agents = get().agents.map((a) => (a.agent_id === agentId ? { ...a, state } : a));
    await persist(agents);
    set({ agents });
  },

  recordApprovedRun: async (agentId) => {
    const agents = get().agents.map((a) =>
      a.agent_id === agentId ? { ...a, approved_runs: a.approved_runs + 1 } : a,
    );
    await persist(agents);
    set({ agents });
  },

  grantDraftAutonomy: async (agentId) => {
    const agents = get().agents.map((a) =>
      a.agent_id === agentId ? { ...a, draft_autonomy: true } : a,
    );
    await persist(agents);
    set({ agents });
  },

  registerOnServer: async (agentId, candidate) => {
    const agent = get().agents.find((a) => a.agent_id === agentId);
    if (!agent) return { ok: false, message: "agent not found" };
    if (agent.server_agent_id) return { ok: true, server_agent_id: agent.server_agent_id };
    if (!isTauri()) {
      return { ok: false, message: "Server runs require the desktop app." };
    }
    try {
      // 1. Compile on the server (the configured model provider runs there; the
      //    server binds org/owner from the device principal, not the client).
      const compiled = await invokeCommand<{
        spec: AgentSpec;
        model_usage?: { input_tokens: number; output_tokens: number; model_alias: string };
        model_cost_usd?: number;
      }>("server_compile_agent", {
        body: {
          candidate,
          generalized_intent: agent.generalized_intent,
          desired_outcome: agent.desired_outcome,
        },
      });
      // 2. Persist the compiled spec (agent + immutable version).
      const created = await invokeCommand<{ agent_id: string; agent_version_id: string }>(
        "server_create_agent",
        {
          body: {
            spec: compiled.spec,
            ...(compiled.model_usage ? { model_usage: compiled.model_usage } : {}),
            ...(compiled.model_cost_usd !== undefined
              ? { model_cost_usd: compiled.model_cost_usd }
              : {}),
          },
        },
      );
      const agents = get().agents.map((a) =>
        a.agent_id === agentId ? { ...a, server_agent_id: created.agent_id } : a,
      );
      await persist(agents);
      set({ agents });
      return { ok: true, server_agent_id: created.agent_id };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  },
}));
