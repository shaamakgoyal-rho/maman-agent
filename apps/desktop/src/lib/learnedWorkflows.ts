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

/** Thrown instead of writing over a file whose contents we never understood. */
export class WorkflowsNotLoadedError extends Error {
  constructor(detail: string) {
    super(
      `I could not read your taught workflows (${detail}), so I will not save over that file — doing so would replace it with an empty list. The file is untouched.`,
    );
    this.name = "WorkflowsNotLoadedError";
  }
}

/**
 * What reading the workflows file produced.
 *
 * This used to return `{workflows: [], discarded: 0}` for THREE different
 * situations: no file at all, bytes that were not JSON, and an object with no
 * `workflows` array. Only the first is "you have not taught me anything yet";
 * the other two are "there is something here I could not read", and the three
 * saves below would then have replaced it with the empty list.
 *
 * Same defect as the agents store, same fix — see `parseAgentsFile`.
 */
export type WorkflowsLoad =
  | { kind: "absent" }
  | { kind: "unreadable"; detail: string }
  | { kind: "loaded"; workflows: LearnedWorkflow[]; discarded: number };

/**
 * Reads the persisted file, tolerating a shape from an earlier build.
 *
 * A record that cannot be repaired is KEPT OUT of the active list rather than
 * silently coerced into something the user did not configure — a half-parsed
 * workflow is exactly the kind of thing that would compile into an agent doing
 * not-quite-what-was-asked.
 */
export function parseWorkflowsFile(raw: string | null): WorkflowsLoad {
  if (raw === null || raw.trim() === "") return { kind: "absent" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { kind: "unreadable", detail: e instanceof Error ? e.message : "not valid JSON" };
  }

  const whole = fileSchema.safeParse(parsed);
  if (whole.success) return { kind: "loaded", workflows: whole.data.workflows, discarded: 0 };

  // Per-record salvage: one bad workflow must not cost the user the rest.
  const list = (parsed as { workflows?: unknown }).workflows;
  if (!Array.isArray(list)) {
    return { kind: "unreadable", detail: "the file has no workflows list" };
  }
  const workflows: LearnedWorkflow[] = [];
  let discarded = 0;
  for (const item of list) {
    const one = learnedWorkflowSchema.safeParse(item);
    if (one.success) workflows.push(one.data);
    else discarded += 1;
  }
  return { kind: "loaded", workflows, discarded };
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
  /**
   * Set when the file existed but could not be understood. While this is set
   * the store REFUSES to write, because saving the (empty) in-memory list would
   * replace whatever is on disk with nothing.
   */
  loadFailure: string | null;
  hydrate: () => Promise<void>;
  /** Creates (or returns) the draft for a pattern. Idempotent per pattern. */
  startFor: (candidate: PatternCandidate, ownerUserId: string) => Promise<LearnedWorkflow>;
  update: (
    workflowId: string,
    edit: Partial<Pick<LearnedWorkflow, "name" | "allowed_origins" | "steps" | "trigger">>,
  ) => Promise<LearnedWorkflow | null>;
  remove: (workflowId: string) => Promise<void>;
};

/**
 * The single write path, so the refusal cannot be forgotten at one of three
 * call sites. Each previously inlined `saveRaw(JSON.stringify(...))`.
 */
async function persist(workflows: LearnedWorkflow[]): Promise<void> {
  const failure = useLearnedWorkflows.getState().loadFailure;
  if (failure !== null) throw new WorkflowsNotLoadedError(failure);
  await saveRaw(JSON.stringify({ schema_version: 1, workflows }));
}

export const useLearnedWorkflows = create<Store>((set, get) => ({
  workflows: [],
  hydrated: false,
  discarded: 0,
  loadFailure: null,

  hydrate: async () => {
    let raw: string | null = null;
    try {
      raw = await loadRaw();
    } catch (error) {
      // This branch already CLAIMED to report the failure — it logged to the
      // console and then set an empty list marked `hydrated`, which the three
      // saves below would have written over. A console line the user never sees
      // is not a report; refusing to destroy their file is.
      set({
        workflows: [],
        hydrated: true,
        discarded: 0,
        loadFailure: error instanceof Error ? error.message : "could not read the workflows file",
      });
      return;
    }

    const load = parseWorkflowsFile(raw);
    if (load.kind === "unreadable") {
      set({ workflows: [], hydrated: true, discarded: 0, loadFailure: load.detail });
      return;
    }
    if (load.kind === "absent") {
      set({ workflows: [], hydrated: true, discarded: 0, loadFailure: null });
      return;
    }
    set({
      workflows: load.workflows,
      hydrated: true,
      discarded: load.discarded,
      loadFailure: null,
    });
  },

  startFor: async (candidate, ownerUserId) => {
    const existing = get().workflows.find((w) => w.source_pattern_id === candidate.pattern_id);
    if (existing) return existing;
    const draft = draftFromCandidate(candidate, ownerUserId);
    const workflows = [...get().workflows, draft];
    set({ workflows });
    await persist(workflows);
    return draft;
  },

  update: async (workflowId, edit) => {
    const current = get().workflows.find((w) => w.workflow_id === workflowId);
    if (!current) return null;
    const next = applyEdit(current, edit);
    const workflows = get().workflows.map((w) => (w.workflow_id === workflowId ? next : w));
    set({ workflows });
    await persist(workflows);
    return next;
  },

  remove: async (workflowId) => {
    const workflows = get().workflows.filter((w) => w.workflow_id !== workflowId);
    set({ workflows });
    await persist(workflows);
  },
}));
