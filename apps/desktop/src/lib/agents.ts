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
}));
