import type { AgentSpec, AgentTrigger, WorkflowContext } from "@maman/contracts";
import {
  diffSha256,
  type CapabilityAdapter,
  type CapabilityContext,
  type ProposedDiff,
} from "./adapters.js";
import { executeStep, type RunState } from "./run-engine.js";
import {
  requireAdapter,
  runtimeFromRegistry,
  validateRuntimeCapabilities,
  type RuntimeReadiness,
} from "./runtime-capabilities.js";
import { validateAgentInputs, type InputReadiness } from "./agent-inputs.js";
import { validateAgentSpec } from "./validator.js";

/**
 * THE LOCAL AGENT RUNTIME — the piece Create Agent was missing.
 *
 * The Create Agent path used to be: compile → persist a record with
 * `state: "draft"` → show success → stop. Nothing validated the spec against a
 * runtime, nothing registered it anywhere, nothing installed its trigger, and
 * nothing could execute it later without the user going back to the Agents
 * screen and pressing Run. A persisted object called an "agent" is not an
 * agent; it is a description of one.
 *
 * This runtime is the registration target. It lives at MODULE scope in its
 * consumers — never inside a React component — so an agent's lifetime is the
 * app's lifetime, not a screen's. It is deliberately pure and injectable:
 * the adapter registry, the clock, and persistence all come in through the
 * constructor, so the same class is exercised by tests, the desktop, and a
 * future worker host without divergence.
 *
 * NO MODEL, NO FIXTURES, NO KEYS. Nothing in this file can reach a model
 * provider — there is no field to put one in. What it can execute is decided
 * entirely by the injected registry, which is how REAL and DEMO environments
 * stay structurally separate: a runtime built with the real registry cannot
 * serve demo data because the demo adapters are not in the map it holds.
 */

/** How an agent registration can fail, each one actionable by name. */
export type RegistrationResult =
  | { ok: true; agent_id: string }
  | {
      ok: false;
      reason: "invalid_spec" | "runtime_unavailable";
      /** Specific, user-facing: "capability browser.form_fill is unavailable". */
      detail: string;
      readiness?: RuntimeReadiness;
    };

export type ShadowOutcome =
  | {
      status: "shadow_complete";
      /** What the agent would change. Empty for a read-only agent. */
      diff: ProposedDiff | null;
      steps_run: number;
      records_read: number;
    }
  | {
      status: "needs_input";
      /** Present when the gap came from the spec's own declared inputs. */
      readiness?: Extract<InputReadiness, { ready: false }>;
      detail: string;
    }
  | { status: "failed"; detail: string };

export type ApprovedOutcome =
  | {
      status: "completed";
      diff: ProposedDiff;
      /** The adapter's independent readback confirmed every change landed. */
      verified: boolean;
      verify_detail: string;
    }
  | {
      /**
       * The surface changed between approval and execution: re-proposing
       * against the live page produced a DIFFERENT diff than the one the user
       * approved, so nothing was written. Not a failure — the protection
       * working. The caller shows the fresh diff and asks again.
       */
      status: "aborted_stale";
      approved_sha: string;
      fresh_sha: string;
      fresh_diff: ProposedDiff | null;
    }
  | { status: "needs_input"; detail: string }
  | { status: "failed"; detail: string };

/** One agent as the runtime holds it: the spec, its switch, and its history. */
export interface RegisteredAgent {
  spec: AgentSpec;
  enabled: boolean;
  last_triggered_at: string | null;
  last_run_at: string | null;
}

/** A trigger match the service should act on, with the dedupe already applied. */
export interface TriggerFiring {
  agent_id: string;
  agent_name: string;
  trigger: Extract<AgentTrigger, { type: "context" }>;
  context: WorkflowContext;
}

export interface LocalAgentRuntimeDeps {
  /** Adapter registry — THE environment. Real or demo is decided here, once. */
  registry: Map<string, CapabilityAdapter>;
  /** Stable id for refusal messages ("the local runtime has no adapter for…"). */
  runtime_id: string;
  now?: () => Date;
  /**
   * Called whenever an agent's runtime record changes (registered, triggered,
   * ran), so the host can persist it. Persistence is the host's, not the
   * runtime's: the desktop writes the agents file, a test writes a map.
   */
  onAgentChanged?: (agent: RegisteredAgent) => void;
}

/** Host of an already-validated https origin ("https://a.example" → "a.example"). */
function hostOf(origin: string): string {
  return origin.replace(/^https:\/\//, "").split("/")[0] ?? origin;
}

export class LocalAgentRuntime {
  private readonly agents = new Map<string, RegisteredAgent>();
  private readonly deps: LocalAgentRuntimeDeps;
  private readonly now: () => Date;

  constructor(deps: LocalAgentRuntimeDeps, restore: readonly RegisteredAgent[] = []) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
    // RESTART PATH. The host hands back what it persisted, and every agent is
    // re-validated on the way in rather than trusted: the registry may have
    // changed since the agent was created (an origin removed, a connector
    // unlinked), and a restored agent the runtime can no longer execute must
    // surface as unavailable, not lie dormant until a trigger crashes it.
    for (const agent of restore) {
      const result = this.registerAgent(agent.spec, { enabled: agent.enabled });
      if (result.ok) {
        const restored = this.agents.get(agent.spec.agent_id)!;
        restored.last_triggered_at = agent.last_triggered_at;
        restored.last_run_at = agent.last_run_at;
      }
    }
  }

  /**
   * Registers an agent for execution. This is a VALIDATION, not a bookkeeping
   * insert: a spec the runtime cannot execute is refused with the exact gap.
   */
  registerAgent(spec: AgentSpec, opts: { enabled?: boolean } = {}): RegistrationResult {
    const validation = validateAgentSpec(spec);
    if (!validation.valid) {
      return {
        ok: false,
        reason: "invalid_spec",
        detail: validation.issues[0]?.message ?? "the spec failed static validation",
      };
    }

    const readiness = validateRuntimeCapabilities(
      validation.spec,
      runtimeFromRegistry(this.deps.runtime_id, this.deps.registry),
    );
    if (!readiness.ready) {
      const first = readiness.missing[0];
      return {
        ok: false,
        reason: "runtime_unavailable",
        detail: first
          ? `capability ${first.capability_id} is unavailable on ${this.deps.runtime_id}: ${first.detail}`
          : "the runtime cannot execute this spec",
        readiness,
      };
    }

    const record: RegisteredAgent = {
      spec: validation.spec,
      enabled: opts.enabled ?? true,
      last_triggered_at: null,
      last_run_at: null,
    };
    this.agents.set(spec.agent_id, record);
    this.deps.onAgentChanged?.(record);
    return { ok: true, agent_id: spec.agent_id };
  }

  unregisterAgent(agentId: string): void {
    this.agents.delete(agentId);
  }

  setEnabled(agentId: string, enabled: boolean): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    agent.enabled = enabled;
    this.deps.onAgentChanged?.(agent);
  }

  get(agentId: string): RegisteredAgent | undefined {
    return this.agents.get(agentId);
  }

  list(): RegisteredAgent[] {
    return [...this.agents.values()];
  }

  listCapabilities(): string[] {
    return [...this.deps.registry.keys()].sort();
  }

  /**
   * Evaluates one observed context against every enabled agent's trigger.
   *
   * Dedupe is HERE, not in the caller: within an agent's cooldown window the
   * same context fires nothing, because the observation stream emits one event
   * per user action and a workflow is many actions — without this, opening one
   * record would stage the same agent a dozen times.
   *
   * The trigger is installed BY registration (it lives on the spec), so there
   * is no separate installTrigger call to forget. An agent whose spec carries a
   * context trigger is proactive from the moment registration succeeds.
   */
  handleContext(context: WorkflowContext): TriggerFiring[] {
    const firings: TriggerFiring[] = [];
    const nowMs = this.now().getTime();

    for (const agent of this.agents.values()) {
      if (!agent.enabled) continue;
      const trigger = agent.spec.trigger;
      if (trigger.type !== "context") continue;

      if (trigger.app_category !== context.app_category) continue;
      if (trigger.object_type !== undefined && trigger.object_type !== context.object_type) {
        continue;
      }
      // The trigger names a full origin (it came from the actuation
      // allowlist); observation reports a bare host. Compare host-to-host,
      // EXACTLY — a suffix match is how evil-example.com wakes an agent meant
      // for example.com.
      if (trigger.origin !== undefined && hostOf(trigger.origin) !== context.domain) continue;

      if (agent.last_triggered_at !== null) {
        const elapsed = nowMs - Date.parse(agent.last_triggered_at);
        if (elapsed < trigger.cooldown_seconds * 1000) continue;
      }

      agent.last_triggered_at = this.now().toISOString();
      this.deps.onAgentChanged?.(agent);
      firings.push({
        agent_id: agent.spec.agent_id,
        agent_name: agent.spec.name,
        trigger,
        context,
      });
    }
    return firings;
  }

  /**
   * Runs the agent's read and propose steps and STOPS. No write is dispatched,
   * structurally: the loop never calls a write mode, so there is no code path
   * from here to an adapter's `write`.
   *
   * Inputs are the caller's to supply (discovery, user answers, constants from
   * the learned workflow). A required input that is absent fails CLOSED with
   * the named gap — never a fixture, never a default.
   */
  async runShadow(
    agentId: string,
    agentInputs: Record<string, unknown>,
    ctx: Omit<CapabilityContext, "mode">,
  ): Promise<ShadowOutcome> {
    const agent = this.agents.get(agentId);
    if (!agent) return { status: "failed", detail: `no agent ${agentId} is registered` };

    const inputs = validateAgentInputs(agent.spec, agentInputs);
    if (!inputs.ready) {
      return {
        status: "needs_input",
        readiness: inputs,
        detail: inputs.missing.map((m) => m.label).join(", "),
      };
    }

    const state: RunState = { outputs: {} };
    const runCtx: CapabilityContext = { ...ctx, mode: "shadow" };
    let diff: ProposedDiff | null = null;
    let stepsRun = 0;
    let recordsRead = 0;

    try {
      for (const step of [...agent.spec.steps].sort((a, b) => a.order - b.order)) {
        if (step.mode === "write") continue; // shadow: the write is never reached
        const result = await executeStep({
          spec: agent.spec,
          step,
          state,
          agentInputs,
          ctx: runCtx,
          adapter: requireAdapter(this.deps.registry, step, this.deps.runtime_id),
        });
        stepsRun += 1;
        if (result.kind === "read" && Array.isArray(result.output)) {
          recordsRead += result.output.length;
        }
        if (result.kind === "proposed") diff = result.diff;
      }
    } catch (e) {
      // The step's own message is the useful part ("no Phone field", "origin
      // not allowed") — pass it through instead of flattening to "failed".
      return { status: "failed", detail: e instanceof Error ? e.message : String(e) };
    }

    agent.last_run_at = this.now().toISOString();
    this.deps.onAgentChanged?.(agent);
    return { status: "shadow_complete", diff, steps_run: stepsRun, records_read: recordsRead };
  }

  /**
   * Executes the agent's FULL plan, writes included, against a diff the user
   * approved — propose → approve → execute → readback, with the stale-page
   * abort the mandate requires.
   *
   * The reads and the propose re-run FRESH, and the re-proposed diff's hash
   * must equal the approved hash. If the page moved on since the user looked —
   * someone else edited the record, the form re-rendered differently — the
   * hashes differ and NOTHING is written: modifying a different value because
   * the approved one no longer exists is the exact outcome this refuses.
   * `executeStep` then binds the write to the same hash a second time, and the
   * browser adapter re-checks each field's expect_current against the live DOM
   * at the instant of the write — three layers, because a stale write cannot
   * be retracted.
   */
  async runApproved(
    agentId: string,
    agentInputs: Record<string, unknown>,
    ctx: Omit<CapabilityContext, "mode">,
    approvedDiffSha: string,
  ): Promise<ApprovedOutcome> {
    const agent = this.agents.get(agentId);
    if (!agent) return { status: "failed", detail: `no agent ${agentId} is registered` };

    const inputs = validateAgentInputs(agent.spec, agentInputs);
    if (!inputs.ready) {
      return { status: "needs_input", detail: inputs.missing.map((m) => m.label).join(", ") };
    }

    const state: RunState = { outputs: {} };
    const runCtx: CapabilityContext = { ...ctx, mode: "supervised" };
    let freshDiff: ProposedDiff | null = null;
    let freshSha = "";
    let written: { verified: boolean; verify_detail: string } | null = null;

    try {
      for (const step of [...agent.spec.steps].sort((a, b) => a.order - b.order)) {
        if (step.mode === "write") {
          if (freshDiff === null || freshSha !== approvedDiffSha) {
            return {
              status: "aborted_stale",
              approved_sha: approvedDiffSha,
              fresh_sha: freshSha,
              fresh_diff: freshDiff,
            };
          }
          const result = await executeStep({
            spec: agent.spec,
            step,
            state,
            agentInputs,
            ctx: runCtx,
            adapter: requireAdapter(this.deps.registry, step, this.deps.runtime_id),
            approvedDiff: freshDiff,
            approvedDiffSha,
          });
          if (result.kind !== "written") {
            return { status: "failed", detail: `the write step returned ${result.kind}` };
          }
          written = { verified: result.verified, verify_detail: result.verify_detail };
          // NOT returning here: the spec's own trailing steps (the verify-read)
          // still run, so the plan the user approved is the plan that executes.
          continue;
        }

        const result = await executeStep({
          spec: agent.spec,
          step,
          state,
          agentInputs,
          ctx: runCtx,
          adapter: requireAdapter(this.deps.registry, step, this.deps.runtime_id),
        });
        if (result.kind === "proposed") {
          freshDiff = result.diff;
          freshSha = diffSha256(result.diff);
        }
      }
    } catch (e) {
      return { status: "failed", detail: e instanceof Error ? e.message : String(e) };
    }

    if (written === null || freshDiff === null) {
      return { status: "failed", detail: "this agent has no write step to approve" };
    }
    agent.last_run_at = this.now().toISOString();
    this.deps.onAgentChanged?.(agent);
    return {
      status: "completed",
      diff: freshDiff,
      verified: written.verified,
      verify_detail: written.verify_detail,
    };
  }
}
