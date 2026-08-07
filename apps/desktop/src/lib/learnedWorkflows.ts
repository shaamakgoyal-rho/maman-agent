import { create } from "zustand";
import { z } from "zod";
import {
  learnedWorkflowSchema,
  uuidv7,
  workflowReadiness,
  type LearnedStep,
  type LearnedWorkflow,
  type PatternCandidate,
} from "@maman/contracts";
import { explainWorkflowSteps } from "@maman/pattern-engine";
import { invokeCommand, isTauri } from "./bridge.js";

/**
 * Locally persisted learned workflows — what the user taught Maman.
 *
 * These are the only place a configured target or value lives. They are stored
 * on the device and never synced: a field name and a constant value are things
 * the user typed about their own work, and the sync payload has no business
 * carrying them.
 */

const fileSchema = z
  .object({
    /**
     * Bumped when the persisted shape changes. A record written by an older
     * version is MIGRATED (below) rather than dropped, because the user typed
     * it and losing it would be losing their work.
     */
    schema_version: z.literal(1).default(1),
    workflows: z.array(learnedWorkflowSchema).default([]),
  })
  .strict();

/**
 * Reads the persisted file, tolerating a shape from an earlier build.
 *
 * A record that cannot be repaired is KEPT OUT of the active list rather than
 * silently coerced into something the user did not configure — a half-parsed
 * workflow is exactly the kind of thing that would compile into an agent doing
 * not-quite-what-was-asked.
 */
export function parseWorkflowsFile(raw: string | null): {
  workflows: LearnedWorkflow[];
  discarded: number;
} {
  if (!raw) return { workflows: [], discarded: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { workflows: [], discarded: 0 };
  }
  const whole = fileSchema.safeParse(parsed);
  if (whole.success) return { workflows: whole.data.workflows, discarded: 0 };

  // Per-record salvage: one bad workflow must not cost the user the rest.
  const list = (parsed as { workflows?: unknown }).workflows;
  if (!Array.isArray(list)) return { workflows: [], discarded: 0 };
  const workflows: LearnedWorkflow[] = [];
  let discarded = 0;
  for (const item of list) {
    const one = learnedWorkflowSchema.safeParse(item);
    if (one.success) workflows.push(one.data);
    else discarded += 1;
  }
  return { workflows, discarded };
}

async function loadRaw(): Promise<string | null> {
  if (isTauri()) return invokeCommand<string | null>("learned_workflows_load");
  return localStorage.getItem("maman-learned-workflows");
}

async function saveRaw(json: string): Promise<void> {
  if (isTauri()) {
    await invokeCommand("learned_workflows_save", { json });
    return;
  }
  localStorage.setItem("maman-learned-workflows", json);
}

/**
 * Seeds a workflow from an observed pattern — the honest starting point for a
 * teach session.
 *
 * It carries over ONLY what was actually observed: the shape of the sequence and
 * how many steps there were. Every target and every value is left empty and
 * listed in `missing_configuration`, because those were never observable. This
 * is the opposite of the old behaviour, which filled the same gaps by inference
 * and produced a workflow the user had not described.
 */
export function draftFromCandidate(
  candidate: PatternCandidate,
  ownerUserId: string,
  now: () => Date = () => new Date(),
): LearnedWorkflow {
  const explanation = explainWorkflowSteps(candidate.canonical_sequence);
  const actionable = explanation.steps.filter((s) => s.automation.kind === "automated");
  const at = now().toISOString();

  const steps: LearnedStep[] = actionable.map((step, i) => {
    const automation = step.automation as {
      kind: "automated";
      steps: Array<{ capability_id: string; mode: string }>;
    };
    // Prefer the reversible propose-first capability, matching how the card
    // describes the workflow to the user.
    const chosen = automation.steps[0]!;
    return {
      step_id: `step-${i + 1}`,
      order: i + 1,
      description: step.observed,
      capability_id: chosen.capability_id,
      mode: chosen.mode as LearnedStep["mode"],
      // NO TARGET AND NO VALUE. Observation saw that a text field changed; it
      // never saw which one, or to what.
      success: chosen.mode === "read" ? { kind: "none" } : { kind: "readback_equals" },
    };
  });

  const missing: LearnedWorkflow["missing_configuration"] = [
    {
      kind: "origin",
      detail: "Which site this workflow runs on.",
    },
    ...steps.map((s) => ({
      kind: "target" as const,
      step_id: s.step_id,
      detail: `Which field step ${s.order} acts on.`,
    })),
    ...steps
      .filter((s) => s.mode !== "read")
      .map((s) => ({
        kind: "value" as const,
        step_id: s.step_id,
        detail: `What value step ${s.order} should write, and where it comes from.`,
      })),
  ];

  return {
    schema_version: 1,
    workflow_id: uuidv7(),
    version: 1,
    source_pattern_id: candidate.pattern_id,
    owner_user_id: ownerUserId,
    name: "Untitled workflow",
    trigger: { type: "manual" },
    allowed_origins: [],
    steps,
    missing_configuration: missing,
    // Nothing has been confirmed yet: every specific is still absent.
    provenance: "observed",
    created_at: at,
    updated_at: at,
  };
}

/**
 * Applies an edit and clears the `missing_configuration` entries it satisfied.
 *
 * Recomputing rather than hand-clearing matters: a stale entry would block a
 * complete workflow, and a hand-cleared one would let an incomplete workflow
 * compile. `workflowReadiness` derives the structural gaps, so this only has to
 * drop the seeded placeholders that are now answered.
 */
export function applyEdit(
  workflow: LearnedWorkflow,
  edit: Partial<Pick<LearnedWorkflow, "name" | "allowed_origins" | "steps" | "trigger">>,
  now: () => Date = () => new Date(),
): LearnedWorkflow {
  const next: LearnedWorkflow = {
    ...workflow,
    ...edit,
    // Any material change is a new version, so a compiled agent always names
    // the exact version it was built from.
    version: workflow.version + 1,
    provenance: "user_configured",
    updated_at: now().toISOString(),
    missing_configuration: [],
  };
  // Re-derive: whatever is still structurally missing comes back.
  const { missing } = workflowReadiness(next);
  return { ...next, missing_configuration: missing };
}

type Store = {
  workflows: LearnedWorkflow[];
  hydrated: boolean;
  /** Records dropped as unparseable on load — surfaced, never hidden. */
  discarded: number;
  hydrate: () => Promise<void>;
  /** Creates (or returns) the draft for a pattern. Idempotent per pattern. */
  startFor: (candidate: PatternCandidate, ownerUserId: string) => Promise<LearnedWorkflow>;
  update: (
    workflowId: string,
    edit: Partial<Pick<LearnedWorkflow, "name" | "allowed_origins" | "steps" | "trigger">>,
  ) => Promise<LearnedWorkflow | null>;
  remove: (workflowId: string) => Promise<void>;
};

export const useLearnedWorkflows = create<Store>((set, get) => ({
  workflows: [],
  hydrated: false,
  discarded: 0,

  hydrate: async () => {
    let raw: string | null = null;
    try {
      raw = await loadRaw();
    } catch (error) {
      // A load failure is REPORTED, not swallowed into an empty list that looks
      // like "you have not taught me anything yet".
      set({ workflows: [], hydrated: true, discarded: 0 });
      console.error("could not read learned workflows", error);
      return;
    }
    const { workflows, discarded } = parseWorkflowsFile(raw);
    set({ workflows, hydrated: true, discarded });
  },

  startFor: async (candidate, ownerUserId) => {
    const existing = get().workflows.find((w) => w.source_pattern_id === candidate.pattern_id);
    if (existing) return existing;
    const draft = draftFromCandidate(candidate, ownerUserId);
    const workflows = [...get().workflows, draft];
    set({ workflows });
    await saveRaw(JSON.stringify({ schema_version: 1, workflows }));
    return draft;
  },

  update: async (workflowId, edit) => {
    const current = get().workflows.find((w) => w.workflow_id === workflowId);
    if (!current) return null;
    const next = applyEdit(current, edit);
    const workflows = get().workflows.map((w) => (w.workflow_id === workflowId ? next : w));
    set({ workflows });
    await saveRaw(JSON.stringify({ schema_version: 1, workflows }));
    return next;
  },

  remove: async (workflowId) => {
    const workflows = get().workflows.filter((w) => w.workflow_id !== workflowId);
    set({ workflows });
    await saveRaw(JSON.stringify({ schema_version: 1, workflows }));
  },
}));
