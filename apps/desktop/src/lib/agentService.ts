import { create } from "zustand";
import {
  browserAdapters,
  type BrowserAdapterDeps,
  compileTraceToAgentSpec,
  intentFittingSteps,
  LocalAgentRuntime,
  observedSemantics,
  resolveIntentOnSurface,
  DISCOVERED_FIELDS_INPUT,
  FIELD_VALUES_INPUT,
  diffSha256,
  type ApprovedOutcome,
  type ProposedDiff,
  type RegisteredAgent,
  type ShadowOutcome,
} from "@maman/agent-runtime";
import {
  parseLocalActionTrace,
  uuidv7,
  type AgentSpec,
  type MissingConfigurationItem,
  type PatternCandidate,
  type WorkflowContext,
} from "@maman/contracts";
import { emitAppEvent, invokeCommand, isTauri, onAppEvent } from "./bridge.js";
import { browserActuationOrigins, browserDispatchDeps } from "./browserRun.js";
import { useAgents } from "./agents.js";
import { useSettings } from "../state/settings.js";
import { userIsPresent } from "./presence.js";

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
 * the browser adapters over the signed Chrome relay. `DemoSalesforceWorld`,
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

/** The browser transport Create Agent uses: the paired Chrome extension relay. */
function chromeRelayDeps(allowSupervisedBrowserWrites: boolean): BrowserAdapterDeps | null {
  const origins = browserActuationOrigins(
    useSettings.getState().settings.browser_actuation_origins ?? [],
  );
  if (origins.length === 0) return null;
  const relay = browserDispatchDeps();
  return {
    dispatch: relay.dispatch,
    allowedOrigins: origins,
    userPresent: userIsPresent,
    allowSupervisedBrowserWrites,
    newRequestId: relay.newRequestId,
    mintAuthorization: relay.mintAuthorization,
    now: relay.now,
  };
}

/** The REAL registry: Chrome relay adapters only. Nothing demo or fixture-backed. */
function realRegistry() {
  const deps = chromeRelayDeps(true);
  return deps ? browserAdapters(deps) : new Map();
}

function persistAgentChange(agent: RegisteredAgent): void {
  void useAgents.getState().recordRuntimeActivity(agent.spec.agent_id, {
    ...(agent.last_triggered_at ? { last_triggered_at: agent.last_triggered_at } : {}),
    ...(agent.last_run_at ? { last_run_at: agent.last_run_at } : {}),
  });
}

async function chromeRelayReady(): Promise<{ ok: true } | { ok: false; detail: string }> {
  if (!isTauri()) {
    return { ok: false, detail: "Chrome automation needs the desktop app." };
  }
  try {
    const status = await invokeCommand<{ connected?: boolean }>("browser_relay_status");
    if (status?.connected) return { ok: true };
    return {
      ok: false,
      detail: "Chrome Browser Relay is not connected. Pair the extension and enable this site.",
    };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : "Chrome Browser Relay is unavailable.",
    };
  }
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
    // Firings the Rust daemon evaluated (live events; works with the panel
    // closed). Staged through the SAME autonomy logic as local evaluations.
    if (event.type === "agent_trigger_fired") {
      void stageFiring(event.firing.agent_id, event.firing.agent_name, event.firing.at);
    }
  });

  // Triggers that fired while no panel existed: the daemon persisted them, and
  // draining here is what makes "it noticed while you were away" true. Each
  // drained firing goes through the SAME autonomy routing as a live one —
  // an agent granted draft_autonomy gets its shadow dispatched now, so the
  // user returns to a ready proposal instead of a suggestion that the daemon
  // could have acted on. The shadow re-resolves against the live page and
  // fails closed if the moment has passed; that is the run's honest answer,
  // not a reason to downgrade the firing. `quiet` skips the status beat: a
  // drained firing is history, not something running at this instant.
  if (isTauri()) {
    try {
      const raw = await invokeCommand<string>("staged_runs_drain");
      const parsed = JSON.parse(raw) as Array<{
        agent_id?: string;
        agent_name?: string;
        at?: string;
      }>;
      for (const firing of Array.isArray(parsed) ? parsed.reverse() : []) {
        if (firing.agent_id && firing.agent_name && firing.at) {
          await stageFiring(firing.agent_id, firing.agent_name, firing.at, { quiet: true });
        }
      }
    } catch {
      // A drain failure loses nothing durable — the file stays for next boot.
    }
  }
}

/** Test seam: reset the module singleton between simulated restarts. */
export function __resetAgentServiceForTests(): void {
  runtime = null;
  booted = false;
  shadowQueue.length = 0;
  shadowInFlight.clear();
  shadowWorkers = 0;
  useAgentService.setState({ creation: [], staged: [] });
}

// ---- trigger handling (the proactive half) ----

async function handleContext(context: WorkflowContext): Promise<void> {
  for (const firing of agentRuntime().handleContext(context)) {
    await stageFiring(firing.agent_id, firing.agent_name, context.occurred_at);
  }
}

/**
 * Stages one firing, whichever evaluator produced it, applying autonomy.
 *
 * AUTONOMY, consumed rather than stored: `draft_autonomy` is the worker-granted
 * grant that exists today. With it, a firing stages an automatic SHADOW — never
 * a write; writes always pass the approval gate. Without it, the firing is a
 * suggestion the user can act on. Level 2 vs Level 1, on the product's own knob.
 */
async function stageFiring(
  agentId: string,
  agentName: string,
  at: string,
  opts: { quiet?: boolean } = {},
): Promise<void> {
  const record = useAgents.getState().agents.find((a) => a.agent_id === agentId);
  if (!opts.quiet) {
    await emitAppEvent({
      type: "status_beat",
      beat: { kind: "running", title: agentName, phase: "reading" },
    });
  }

  if (record?.draft_autonomy) {
    enqueueAutonomousShadow(agentId, agentName, at);
  } else {
    pushStaged({
      staged_id: uuidv7(),
      agent_id: agentId,
      agent_name: agentName,
      at,
      outcome: { kind: "suggested" },
    });
  }
}

/**
 * Autonomous shadow runs go through a small worker pool. Shadow runs share one
 * browser surface (and one machine), so a burst of simultaneous firings — many
 * agents, one context — must queue rather than all dispatch at once. An agent
 * already queued or running is not queued again: the run it gets will read the
 * same live page state its duplicate would have.
 */
const MAX_CONCURRENT_SHADOWS = 2;
const shadowQueue: Array<{ agent_id: string; agent_name: string; at: string }> = [];
const shadowInFlight = new Set<string>();
let shadowWorkers = 0;

function enqueueAutonomousShadow(agentId: string, agentName: string, at: string): void {
  if (shadowInFlight.has(agentId)) return;
  shadowInFlight.add(agentId);
  shadowQueue.push({ agent_id: agentId, agent_name: agentName, at });
  pumpShadowQueue();
}

function pumpShadowQueue(): void {
  while (shadowWorkers < MAX_CONCURRENT_SHADOWS && shadowQueue.length > 0) {
    const job = shadowQueue.shift()!;
    shadowWorkers += 1;
    void runAgentShadow(job.agent_id)
      .then((outcome) => {
        pushStaged({
          staged_id: uuidv7(),
          agent_id: job.agent_id,
          agent_name: job.agent_name,
          at: job.at,
          outcome:
            outcome.status === "shadow_complete"
              ? { kind: "shadow", diff: outcome.diff, steps_run: outcome.steps_run }
              : outcome.status === "needs_input"
                ? { kind: "needs_input", detail: outcome.detail }
                : { kind: "failed", detail: outcome.detail },
        });
      })
      .catch((error: unknown) => {
        // A crashed shadow still reports itself — a queue must not turn a
        // failure into silence.
        pushStaged({
          staged_id: uuidv7(),
          agent_id: job.agent_id,
          agent_name: job.agent_name,
          at: job.at,
          outcome: {
            kind: "failed",
            detail: error instanceof Error ? error.message : "shadow run failed",
          },
        });
      })
      .finally(() => {
        shadowWorkers -= 1;
        shadowInFlight.delete(job.agent_id);
        pumpShadowQueue();
      });
  }
}

function pushStaged(run: StagedRun): void {
  useAgentService.setState((s) => {
    // BOTH evaluators can be alive (Rust daemon + panel runtime), and each
    // holds its own cooldown map — the same firing may arrive twice. One
    // staged entry per agent per cooldown window, whoever announced it first.
    const trigger = agentRuntime().get(run.agent_id)?.spec.trigger;
    const cooldownMs = (trigger?.type === "context" ? trigger.cooldown_seconds : 300) * 1000;
    const duplicate = s.staged.some(
      (r) =>
        r.agent_id === run.agent_id && Math.abs(Date.parse(run.at) - Date.parse(r.at)) < cooldownMs,
    );
    if (duplicate) return s;
    return { staged: [run, ...s.staged].slice(0, 20) };
  });
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
  supplied: Readonly<Record<string, string>> = {},
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
  const deps = chromeRelayDeps(false);
  if (!deps) {
    return {
      ok: false,
      needs_input: false,
      detail: "Choose at least one Chrome actuation origin before this agent can look at the page.",
    };
  }
  const resolution = await resolveIntentOnSurface({
    intent,
    deps,
    ctx: {
      run_id: uuidv7(),
      organization_id: spec.organization_id,
      owner_user_id: spec.owner_user_id,
      mode: "shadow",
    },
    supplied,
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

// ---- the write leg: propose → approve → execute → readback ----

/**
 * Resolves inputs (discovery + the user's answers) and produces the exact diff
 * the user is asked to approve, with its hash. Nothing is written here.
 */
export async function proposeForApproval(
  agentId: string,
  answers: Readonly<Record<string, string>> = {},
): Promise<{ ok: true; diff: ProposedDiff; sha: string } | { ok: false; detail: string }> {
  const registered = agentRuntime().get(agentId);
  if (!registered) return { ok: false, detail: `agent ${agentId} is not registered` };
  const record = useAgents.getState().agents.find((a) => a.agent_id === agentId);
  const inputs = await resolveShadowInputs(registered.spec, record?.source_candidate, answers);
  if (!inputs.ok) return { ok: false, detail: inputs.detail };

  const shadow = await agentRuntime().runShadow(agentId, inputs.values, {
    run_id: uuidv7(),
    organization_id: registered.spec.organization_id,
    owner_user_id: registered.spec.owner_user_id,
  });
  if (shadow.status !== "shadow_complete" || !shadow.diff) {
    return {
      ok: false,
      detail: shadow.status === "shadow_complete" ? "nothing to change" : shadow.detail,
    };
  }
  return { ok: true, diff: shadow.diff, sha: diffSha256(shadow.diff) };
}

/**
 * Executes what the user approved, bound to the hash they saw. The runtime
 * re-proposes fresh and ABORTS if the page has moved on — see
 * `LocalAgentRuntime.runApproved` for the three layers of that protection.
 */
export async function executeApproved(
  agentId: string,
  answers: Readonly<Record<string, string>>,
  approvedSha: string,
): Promise<ApprovedOutcome> {
  const registered = agentRuntime().get(agentId);
  if (!registered) return { status: "failed", detail: `agent ${agentId} is not registered` };
  const record = useAgents.getState().agents.find((a) => a.agent_id === agentId);
  const inputs = await resolveShadowInputs(registered.spec, record?.source_candidate, answers);
  if (!inputs.ok) return { status: "failed", detail: inputs.detail };

  return agentRuntime().runApproved(
    agentId,
    inputs.values,
    {
      run_id: uuidv7(),
      organization_id: registered.spec.organization_id,
      owner_user_id: registered.spec.owner_user_id,
    },
    approvedSha,
  );
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
      missing_configuration?: MissingConfigurationItem[];
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
type TraceCompileAttempt =
  | { kind: "compiled"; agent_id: string; trigger: AgentSpec["trigger"] }
  | { kind: "refused"; message: string; missing_configuration: MissingConfigurationItem[] }
  | { kind: "no_trace" };

/**
 * Finds the representative trace for this candidate and compiles it.
 *
 * THE JOIN, then the heuristic: a candidate stamped with
 * `representative_trace_ref` names the exact trace recorded during its most
 * recent occurrence, and that is what compiles. "Newest trace for the origin"
 * survives only as the fallback for candidates whose events predate stamping —
 * and for a stamped trace that has since expired or been deleted, where the
 * newest observation of the same routine is the honest substitute. No trace at
 * all is a normal answer and falls through to the legacy pattern path.
 */
async function compileFromRepresentativeTrace(
  candidate: PatternCandidate,
  displayName?: string,
): Promise<TraceCompileAttempt> {
  if (!isTauri()) return { kind: "no_trace" };

  let raw: string | null = null;
  if (candidate.representative_trace_ref) {
    try {
      raw = await invokeCommand<string | null>("action_trace_get", {
        traceId: candidate.representative_trace_ref,
      });
    } catch {
      raw = null; // lookup unavailable ≠ refusal — the fallback below decides
    }
  }

  if (!raw) {
    const derived = deriveTrigger(candidate);
    const origin = derived.type === "context" ? derived.origin : undefined;
    if (!origin) return { kind: "no_trace" };
    const host = origin.replace(/^https?:\/\//, "").split("/")[0]!;
    try {
      raw = await invokeCommand<string | null>("action_trace_lookup", { host });
    } catch {
      return { kind: "no_trace" }; // lookup unavailable ≠ refusal
    }
  }
  if (!raw) return { kind: "no_trace" };

  const parsed = parseLocalActionTrace(JSON.parse(raw));
  if (!parsed.ok) return { kind: "no_trace" }; // an unusable stored trace is not the user's problem to answer for

  const result = compileTraceToAgentSpec({
    trace: parsed.trace,
    pattern_id: candidate.pattern_id,
    owner_user_id: "00000000-0000-7000-8000-000000000001",
    organization_id: "00000000-0000-7000-8000-000000000002",
    name: displayName ?? "A workflow I watched you repeat",
    availableCapabilities: new Set(realRegistry().keys()),
  });
  if (!result.ok) {
    return {
      kind: "refused",
      message: result.missing_configuration[0]?.detail ?? result.detail,
      missing_configuration: result.missing_configuration,
    };
  }
  await useAgents.getState().createFromSpec(result.spec, candidate, displayName);
  return { kind: "compiled", agent_id: result.spec.agent_id, trigger: result.spec.trigger };
}

export async function createAgentAndActivate(
  candidate: PatternCandidate,
  generalizedIntent: string,
  desiredOutcome: string,
  displayName?: string,
): Promise<CreateAgentOutcome> {
  useAgentService.setState({ creation: [] });
  progress("compiling", "Compiling the workflow…");

  // THE TRACE PATH, FIRST. If observation kept a replayable trace of this
  // routine, the agent is compiled FROM THE EVIDENCE — every step an observed
  // action, provenance in the spec — instead of matched to a recipe. The
  // legacy pattern path below survives only for candidates that predate trace
  // capture; when a trace EXISTS but cannot compile, the typed refusal is the
  // answer (one inline question), never a recipe substitution.
  let agentId: string;
  let compiledTrigger: AgentSpec["trigger"] | null = null;
  const fromTrace = await compileFromRepresentativeTrace(candidate, displayName);
  if (fromTrace.kind === "refused") {
    progress("failed", fromTrace.message);
    return {
      ok: false,
      message: fromTrace.message,
      missing_configuration: fromTrace.missing_configuration,
    };
  }
  if (fromTrace.kind === "compiled") {
    progress("compiling", "Compiled from the workflow I watched — no model, no recipe.");
    agentId = fromTrace.agent_id;
    compiledTrigger = fromTrace.trigger;
  } else {
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
    agentId = created.agent.agent_id;
  }

  progress("installing_trigger", "Installing the trigger…");
  const trigger = compiledTrigger ?? deriveTrigger(candidate);
  const spec = await useAgents.getState().finalizeCreation(agentId, trigger, "shadow");
  if (!spec) {
    progress("failed", "The trigger did not pass spec validation.");
    return { ok: false, message: "The trigger did not pass spec validation." };
  }

  progress("checking_runtime", "Checking this device can run it…");
  const relay = await chromeRelayReady();
  if (!relay.ok) {
    await useAgents.getState().setState(agentId, "draft");
    progress("failed", relay.detail);
    return { ok: false, message: relay.detail };
  }

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
