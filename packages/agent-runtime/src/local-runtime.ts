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

  /**
   * Swaps the capability registry LIVE — the environment changed, not the
   * agents. Called when the user grants or revokes an actuation origin:
   * revocation must bite immediately (the very next step resolves against the
   * new registry and finds nothing), and a grant must work without restarting
   * Maman. Registered agents stay registered; whether they can still RUN is
   * re-answered per run, which is the honest reading of a permission change.
   */
  replaceRegistry(registry: Map<string, CapabilityAdapter>): void {
    this.deps.registry = registry;
  }

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

      // THE ORIGIN IS THE PRECISE SELECTOR. When a trigger names a full origin
      // (every trace-compiled browser agent does), the host uniquely identifies
      // the site and app_category is NOT also required — because the compiler
      // stamps "browser" while the ingest categorizer maps the same domain to
      // "crm"/"email"/"spreadsheet", so demanding both equalities rejected every
      // SaaS agent forever. Host is compared EXACTLY (a suffix match is how
      // evil-example.com would wake an agent meant for example.com). Without an
      // origin (native/legacy triggers), app_category is the selector.
      if (trigger.origin !== undefined) {
        if (hostOf(trigger.origin) !== context.domain) continue;
      } else if (trigger.app_category !== context.app_category) {
        continue;
      }
      if (trigger.object_type !== undefined && trigger.object_type !== context.object_type) {
        continue;
      }

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
        // MERGED, not last-wins: a routine with several consequential steps
        // (fill a field, then press Save) proposes ONE combined diff — the
        // whole change the user is being shown, not just its tail.
        if (result.kind === "proposed") diff = mergeDiffs(diff, result.diff);
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
    const ordered = [...agent.spec.steps].sort((a, b) => a.order - b.order);

    // ---- PASS 1: reads and proposals only, fresh against the live page ----
    //
    // Every proposal re-runs BEFORE anything writes, and the MERGED diff must
    // hash to what the user approved. Interleaving (the old shape) checked
    // staleness one pair at a time, which meant a two-write routine could land
    // its first write and then abort — a partial write that cannot be
    // retracted. Checking the whole plan first means staleness aborts with
    // NOTHING written, which is the only acceptable failure order.
    let freshDiff: ProposedDiff | null = null;
    const proposedByKey = new Map<string, ProposedDiff>();
    try {
      for (const step of ordered) {
        if (step.mode === "write") continue;
        const result = await executeStep({
          spec: agent.spec,
          step,
          state,
          agentInputs,
          ctx: runCtx,
          adapter: requireAdapter(this.deps.registry, step, this.deps.runtime_id),
        });
        if (result.kind === "proposed") {
          proposedByKey.set(step.output_key, result.diff);
          freshDiff = mergeDiffs(freshDiff, result.diff);
        }
      }
    } catch (e) {
      return { status: "failed", detail: e instanceof Error ? e.message : String(e) };
    }

    const freshSha = freshDiff ? diffSha256(freshDiff) : "";
    if (freshDiff === null || freshSha !== approvedDiffSha) {
      return {
        status: "aborted_stale",
        approved_sha: approvedDiffSha,
        fresh_sha: freshSha,
        fresh_diff: freshDiff,
      };
    }

    // ---- PASS 2: the writes, each bound to the slice it proposes ----
    //
    // A write step compiled from a trace names its proposing sibling via the
    // `pairs_with` literal (its output_key), so a press executes against the
    // press's own proposal, not the form fill's. A write with no named pair —
    // every agent compiled before pairing existed — takes the whole merged
    // diff, which for those single-pair specs IS its proposal.
    let written: { verified: boolean; verify_detail: string } | null = null;
    try {
      for (const step of ordered) {
        if (step.mode !== "write") continue;
        const pairKey = step.inputs["pairs_with"];
        const slice =
          pairKey?.source === "literal" && typeof pairKey.value === "string"
            ? (proposedByKey.get(pairKey.value) ?? null)
            : freshDiff;
        if (slice === null) {
          return {
            status: "failed",
            detail: `write step ${step.step_id} pairs with a proposal that produced nothing`,
          };
        }
        const result = await executeStep({
          spec: agent.spec,
          step,
          state,
          agentInputs,
          ctx: runCtx,
          adapter: requireAdapter(this.deps.registry, step, this.deps.runtime_id),
          approvedDiff: slice,
          approvedDiffSha: diffSha256(slice),
        });
        if (result.kind !== "written") {
          return { status: "failed", detail: `the write step returned ${result.kind}` };
        }
        written =
          written === null
            ? { verified: result.verified, verify_detail: result.verify_detail }
            : {
                // The run is verified only when EVERY write read back correctly.
                verified: written.verified && result.verified,
                verify_detail: [written.verify_detail, result.verify_detail]
                  .filter(Boolean)
                  .join("; "),
              };
      }
    } catch (e) {
      return { status: "failed", detail: e instanceof Error ? e.message : String(e) };
    }

    if (written === null) {
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

/**
 * Two proposals → one, additively. The merged diff is what the user approves:
 * the WHOLE routine's changes, in plan order, never just the last step's.
 */
function mergeDiffs(a: ProposedDiff | null, b: ProposedDiff): ProposedDiff {
  if (a === null) return b;
  return {
    summary: {
      input_rows: a.summary.input_rows + b.summary.input_rows,
      confident_matches: a.summary.confident_matches + b.summary.confident_matches,
      ambiguous_skipped: a.summary.ambiguous_skipped + b.summary.ambiguous_skipped,
      missing: a.summary.missing + b.summary.missing,
      change_count: a.summary.change_count + b.summary.change_count,
      accounts_affected: Math.max(a.summary.accounts_affected, b.summary.accounts_affected),
    },
    changes: [...a.changes, ...b.changes],
  };
}
