import { create } from "zustand";
import { z } from "zod";
import { agentSpecSchema, uuidv7, type AgentSpec, type PatternCandidate } from "@maman/contracts";
import {
  compileAgentSpec,
  renderPlainLanguagePlan,
  stateAfterMaterialEdit,
  validateAgentSpec,
} from "@maman/agent-runtime";
import { DEFAULT_ORG_POLICY } from "@maman/policy-engine";
import { DemoModelProvider } from "@maman/model-provider";
import { invokeCommand, isTauri } from "./bridge.js";

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

export type CreateDraftResult =
  { ok: true; agent: AgentRecord; policy_summary: string } | { ok: false; message: string };

type AgentsStore = {
  agents: AgentRecord[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  createDraft: (
    candidate: PatternCandidate,
    generalizedIntent: string,
    desiredOutcome: string,
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
};

export const useAgents = create<AgentsStore>((set, get) => ({
  agents: [],
  hydrated: false,

  hydrate: async () => {
    try {
      const raw = await loadRaw();
      if (raw) {
        const parsed = agentsFileSchema.safeParse(JSON.parse(raw));
        if (parsed.success) {
          set({ agents: parsed.data.agents, hydrated: true });
          return;
        }
      }
    } catch {
      // defaults
    }
    set({ agents: [], hydrated: true });
  },

  createDraft: async (candidate, generalizedIntent, desiredOutcome) => {
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
    });

    if (result.status === "blocked") {
      return { ok: false, message: result.message };
    }

    const agent: AgentRecord = {
      agent_id: result.spec.agent_id,
      name: result.spec.name,
      state: "draft", // never silently active
      versions: [
        {
          version_id: result.spec.version_id,
          version_number: 1,
          spec: result.spec,
          plain_language_plan: result.plain_language_plan,
          created_at: result.spec.created_at,
          created_by: "compiler",
        },
      ],
      created_at: result.spec.created_at,
      server_agent_id: null,
      generalized_intent: generalizedIntent,
      desired_outcome: desiredOutcome,
    };
    const agents = [...get().agents.filter((a) => a.agent_id !== agent.agent_id), agent];
    await saveRaw(JSON.stringify(agentsFileSchema.parse({ schema_version: 1, agents })));
    set({ agents });
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
        created_at: new Date().toISOString(),
        created_by: "user",
      },
    ];
    // Material edit returns the agent to shadow.
    agent.state = stateAfterMaterialEdit(agent.state);
    await saveRaw(JSON.stringify(agentsFileSchema.parse({ schema_version: 1, agents })));
    set({ agents });
    return true;
  },

  setState: async (agentId, state) => {
    const agents = get().agents.map((a) => (a.agent_id === agentId ? { ...a, state } : a));
    await saveRaw(JSON.stringify(agentsFileSchema.parse({ schema_version: 1, agents })));
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
      await saveRaw(JSON.stringify(agentsFileSchema.parse({ schema_version: 1, agents })));
      set({ agents });
      return { ok: true, server_agent_id: created.agent_id };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  },
}));
