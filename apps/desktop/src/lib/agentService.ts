import { create } from "zustand";
import {
  browserAdapters,
  intentFittingSteps,
  LocalAgentRuntime,
  observedSemantics,
  resolveIntentOnSurface,
  DISCOVERED_FIELDS_INPUT,
  FIELD_VALUES_INPUT,
  type MissingConfiguration,
  type ProposedDiff,
  type RegisteredAgent,
  type ShadowOutcome,
} from "@maman/agent-runtime";
import {
  uuidv7,
  type AgentSpec,
  type PatternCandidate,
  type WorkflowContext,
} from "@maman/contracts";
import { emitAppEvent, onAppEvent } from "./bridge.js";
import { tauriAgentBrowserHost } from "./agentBrowser.js";
import { mintAuthorization } from "./browserRun.js";
import { useAgents } from "./agents.js";
import { useSettings } from "../state/settings.js";
import { userIsPresent } from "./runs.js";

/**
 * THE AGENT SERVICE — module scope, booted from the panel ENTRY, not a screen.
 *
 * Create Agent used to be: compile → persist `state: "draft"` → beat → stop.
 * Nothing registered the result with anything able to execute it, nothing
 * installed its trigger, and "proactive" was the user remembering to open the
 * Agents tab. This module is the missing half of that verb, and it survives
 * navigation because nothing here is a React component: the runtime and the
 * context subscription live for the life of the webview.
 *
 * ENVIRONMENT: REAL, structurally. The runtime this service builds holds ONLY
 * the browser adapters over Maman's own window. `DemoSalesforceWorld`,
 * `demoAdapterRegistry` and `local.parse_csv` are not imported by this module,
 * so no code path from a trigger can reach fixture data — an agent whose spec
 * wants a demo capability fails REGISTRATION with the capability named, which
 * is the honest outcome. The demo arcs keep their own registry in runs.ts and
 * are labelled as such.
 *
 * NO MODEL, NO KEYS. Nothing in this file can reach a model provider.
 */

export type CreationPhase =
  | "compiling"
  | "checking_runtime"
  | "registering"
  | "installing_trigger"
  | "shadow_running"
  | "done"
  | "failed";

export type CreationProgress = { phase: CreationPhase; detail: string };

/** One trigger firing the user can act on, staged by the background service. */
export type StagedRun = {
  staged_id: string;
  agent_id: string;
  agent_name: string;
  at: string;
  /** What autonomy allowed: a suggestion, or an already-run shadow result. */
  outcome:
    | { kind: "suggested" }
    | { kind: "shadow"; diff: ProposedDiff | null; steps_run: number }
    | { kind: "needs_input"; detail: string }
    | { kind: "failed"; detail: string };
};

type AgentServiceStore = {
  /** Live progress of the current Create Agent call, for an honest UI. */
  creation: CreationProgress[];
  /** Trigger firings awaiting the user, newest first. Bounded. */
  staged: StagedRun[];
  clearCreation: () => void;
  dismissStaged: (stagedId: string) => void;
};

export const useAgentService = create<AgentServiceStore>((set) => ({
  creation: [],
  staged: [],
  clearCreation: () => set({ creation: [] }),
  dismissStaged: (stagedId) =>
    set((s) => ({ staged: s.staged.filter((r) => r.staged_id !== stagedId) })),
}));

function progress(phase: CreationPhase, detail: string): void {
  useAgentService.setState((s) => ({ creation: [...s.creation, { phase, detail }] }));
}

// ---- the runtime singleton ----

let runtime: LocalAgentRuntime | null = null;
let booted = false;

/** The REAL registry: browser adapters over Maman's own window. Nothing else. */
function realRegistry() {
  const origins = useSettings.getState().settings.browser_actuation_origins ?? [];
  return browserAdapters({
    host: tauriAgentBrowserHost(origins),
    allowedOrigins: origins,
    userPresent: userIsPresent,
    allowSupervisedBrowserWrites: true,
    newRequestId: () => uuidv7(),
    mintAuthorization,
  });
}

function persistAgentChange(agent: RegisteredAgent): void {
  void useAgents.getState().recordRuntimeActivity(agent.spec.agent_id, {
    ...(agent.last_triggered_at ? { last_triggered_at: agent.last_triggered_at } : {}),
    ...(agent.last_run_at ? { last_run_at: agent.last_run_at } : {}),
  });
}

export function agentRuntime(): LocalAgentRuntime {
  runtime ??= new LocalAgentRuntime({
    registry: realRegistry(),
    runtime_id: "local-real",
    onAgentChanged: persistAgentChange,
  });
  return runtime;
}

/**
 * Boots the service: restores persisted agents into the runtime and subscribes
 * to workflow context. Called once from the panel entry (main.tsx) — NOT from a
 * component, so unmounting a screen cannot silence the triggers.
 */
export async function bootAgentService(): Promise<void> {
  if (booted) return;
  booted = true;

  await useAgents.getState().hydrate();
  const restore: RegisteredAgent[] = useAgents
    .getState()
    .agents.filter((a) => a.state !== "archived" && a.state !== "revoked")
    .map((a) => ({
      spec: a.versions[a.versions.length - 1]!.spec,
      enabled: a.state !== "paused",
      last_triggered_at: a.last_triggered_at,
      last_run_at: a.last_run_at,
    }));
  runtime = new LocalAgentRuntime(
    { registry: realRegistry(), runtime_id: "local-real", onAgentChanged: persistAgentChange },
    restore,
  );

  await onAppEvent((event) => {
    if (event.type === "workflow_context") void handleContext(event.context);
  });
}

/** Test seam: reset the module singleton between simulated restarts. */
export function __resetAgentServiceForTests(): void {
  runtime = null;
  booted = false;
  useAgentService.setState({ creation: [], staged: [] });
}

// ---- trigger handling (the proactive half) ----

async function handleContext(context: WorkflowContext): Promise<void> {
  const firings = agentRuntime().handleContext(context);
  for (const firing of firings) {
    const record = useAgents.getState().agents.find((a) => a.agent_id === firing.agent_id);
    const stagedId = uuidv7();
    await emitAppEvent({
      type: "status_beat",
      beat: { kind: "running", title: firing.agent_name, phase: "reading" },
    });

    // AUTONOMY, consumed rather than stored: draft_autonomy is the worker-granted
    // grant that exists today. With it, the firing stages an automatic SHADOW —
    // never a write; writes always pass the approval gate. Without it, the
    // firing is a suggestion the user can act on. That is Level 2 vs Level 1,
    // using the setting the product already has.
    if (record?.draft_autonomy) {
      const outcome = await runAgentShadow(firing.agent_id);
      pushStaged({
        staged_id: stagedId,
        agent_id: firing.agent_id,
        agent_name: firing.agent_name,
        at: context.occurred_at,
        outcome:
          outcome.status === "shadow_complete"
            ? { kind: "shadow", diff: outcome.diff, steps_run: outcome.steps_run }
            : outcome.status === "needs_input"
              ? { kind: "needs_input", detail: outcome.detail }
              : { kind: "failed", detail: outcome.detail },
      });
    } else {
      pushStaged({
        staged_id: stagedId,
        agent_id: firing.agent_id,
        agent_name: firing.agent_name,
        at: context.occurred_at,
        outcome: { kind: "suggested" },
      });
    }
  }
}

function pushStaged(run: StagedRun): void {
  useAgentService.setState((s) => ({ staged: [run, ...s.staged].slice(0, 20) }));
}

/**
 * Shadow through the runtime, with inputs resolved the same way a manual run
 * resolves them: discovery against the live page for `discovered_on_surface`
 * inputs. A required value nobody supplied fails closed as `needs_input`.
 */
export async function runAgentShadow(agentId: string): Promise<ShadowOutcome> {
  const registered = agentRuntime().get(agentId);
  if (!registered) return { status: "failed", detail: `agent ${agentId} is not registered` };

  const record = useAgents.getState().agents.find((a) => a.agent_id === agentId);
  const inputs = await resolveShadowInputs(registered.spec, record?.source_candidate);
  if (!inputs.ok) {
    // "You need to answer something" and "this broke" are different outcomes
    // with different next steps; conflating them buries the ask in red text.
    return inputs.needs_input
      ? { status: "needs_input", detail: inputs.detail }
      : { status: "failed", detail: inputs.detail };
  }

  return agentRuntime().runShadow(agentId, inputs.values, {
    run_id: uuidv7(),
    organization_id: registered.spec.organization_id,
    owner_user_id: registered.spec.owner_user_id,
  });
}

async function resolveShadowInputs(
  spec: AgentSpec,
  candidate: PatternCandidate | undefined,
): Promise<
  | { ok: true; values: Record<string, unknown> }
  | { ok: false; needs_input: boolean; detail: string }
> {
  const needsDiscovery = spec.inputs.some((i) => i.source === "discovered_on_surface");
  if (!needsDiscovery) return { ok: true, values: {} };
  if (!candidate) {
    return {
      ok: false,
      needs_input: false,
      detail: "this agent predates discovery and has no source pattern",
    };
  }
  const intent = intentFittingSteps(candidate.canonical_sequence, spec.steps);
  if (!intent) {
    return {
      ok: false,
      needs_input: false,
      detail: "no catalogued intent says what to look for on the page",
    };
  }
  const origins = useSettings.getState().settings.browser_actuation_origins ?? [];
  const resolution = await resolveIntentOnSurface({
    intent,
    deps: {
      host: tauriAgentBrowserHost(origins),
      allowedOrigins: origins,
      userPresent: userIsPresent,
      allowSupervisedBrowserWrites: false, // discovery only looks
      newRequestId: () => uuidv7(),
      mintAuthorization,
    },
    ctx: {
      run_id: uuidv7(),
      organization_id: spec.organization_id,
      owner_user_id: spec.owner_user_id,
      mode: "shadow",
    },
    observedSemantics: observedSemantics(candidate.canonical_sequence),
  });
  if (resolution.status !== "ready") {
    return {
      ok: false,
      needs_input: resolution.status === "needs_you",
      detail: resolution.message,
    };
  }
  const value = resolution.resolved.filled.find((f) => f.kind === "value");
  return {
    ok: true,
    values: {
      [DISCOVERED_FIELDS_INPUT]: resolution.fields,
      ...(value
        ? { [FIELD_VALUES_INPUT]: resolution.fields.map((f) => ({ ...f, value: value.value })) }
        : {}),
    },
  };
}

// ---- Create Agent, the whole verb ----

/**
 * Derives the context trigger from the pattern the agent came from: the same
 * category-level vocabulary detection matched on, plus the first actuation
 * origin when one is configured. Manual stays available as the fallback.
 */
export function deriveTrigger(candidate: PatternCandidate): AgentSpec["trigger"] {
  const first = candidate.canonical_sequence[0]?.split(":");
  const appCategory = first?.[1];
  if (!appCategory || appCategory === "-") return { type: "manual" };
  const objectType = first?.[5];
  const origin = (useSettings.getState().settings.browser_actuation_origins ?? [])[0];
  return {
    type: "context",
    app_category: appCategory,
    ...(objectType && objectType !== "-" ? { object_type: objectType } : {}),
    ...(origin ? { origin } : {}),
    cooldown_seconds: 300,
  };
}

export type CreateAgentOutcome =
  | { ok: true; agent_id: string; state: "shadow"; shadow: ShadowOutcome }
  | {
      ok: false;
      message: string;
      /** Typed through from the compiler so the UI can route to Teach. */
      missing_configuration?: MissingConfiguration[];
    };

/**
 * What clicking Create Agent now actually does:
 *
 *   compile → validate → persist → register with the LOCAL runtime
 *     → install the trigger → run shadow → state "shadow"
 *
 * Success is only claimed after registration succeeds; a compile that persisted
 * but could not register reports the exact gap and the record stays a draft —
 * visibly incomplete rather than dressed as an agent.
 */
export async function createAgentAndActivate(
  candidate: PatternCandidate,
  generalizedIntent: string,
  desiredOutcome: string,
  displayName?: string,
): Promise<CreateAgentOutcome> {
  useAgentService.setState({ creation: [] });
  progress("compiling", "Compiling the workflow…");

  const created = await useAgents
    .getState()
    .createDraft(candidate, generalizedIntent, desiredOutcome, displayName);
  if (!created.ok) {
    progress("failed", created.message);
    return {
      ok: false,
      message: created.message,
      ...(created.missing_configuration
        ? { missing_configuration: created.missing_configuration }
        : {}),
    };
  }
  const agentId = created.agent.agent_id;

  progress("installing_trigger", "Installing the trigger…");
  const trigger = deriveTrigger(candidate);
  const spec = await useAgents.getState().finalizeCreation(agentId, trigger, "shadow");
  if (!spec) {
    progress("failed", "The trigger did not pass spec validation.");
    return { ok: false, message: "The trigger did not pass spec validation." };
  }

  progress("checking_runtime", "Checking this device can run it…");
  progress("registering", "Registering with the local runtime…");
  const registered = agentRuntime().registerAgent(spec);
  if (!registered.ok) {
    // The record exists but is NOT an agent yet — put it back to draft so the
    // UI cannot show a lifecycle it never reached.
    await useAgents.getState().setState(agentId, "draft");
    progress("failed", registered.detail);
    return { ok: false, message: registered.detail };
  }

  progress("shadow_running", "Running a shadow test — nothing will be written…");
  const shadow = await runAgentShadow(agentId);
  progress(
    "done",
    shadow.status === "shadow_complete"
      ? `Agent created. Shadow test completed: ${shadow.diff?.summary.change_count ?? 0} proposed change(s), nothing written.`
      : shadow.status === "needs_input"
        ? `Agent created and ready. The first shadow run needs one thing from you: ${shadow.detail}.`
        : `Agent created and registered. Shadow test could not finish: ${shadow.detail}`,
  );
  return { ok: true, agent_id: agentId, state: "shadow", shadow };
}
