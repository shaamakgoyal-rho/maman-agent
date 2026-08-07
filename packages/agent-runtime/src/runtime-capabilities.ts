import { getCapability } from "@maman/capability-catalog";
import type { AgentSpec, AgentStep } from "@maman/contracts";

/**
 * RUNTIME capability availability — distinct from catalog existence.
 *
 * `@maman/capability-catalog` answers "is this a capability we define?".
 * That is not the question the run engine needs. It needs "does the runtime I
 * am about to execute on actually have an adapter for this, in the mode the
 * step requires?" — and nothing was asking it.
 *
 * The consequence was live: the browser workflow recipe emits
 * `browser.propose_form_fill` and `browser.supervised_form_fill`, neither of
 * which is registered by any adapter registry in the repository. The desktop
 * run path resolved adapters with `registry.get(step.capability_id)!` — a
 * non-null assertion over a `Map.get` — so `undefined` was handed to
 * `executeStep`, which dereferenced it. A compiled, "verified", user-approved
 * agent would crash with a TypeError on its second step instead of reporting
 * that it cannot run.
 *
 * This module makes unavailability a typed, pre-execution answer.
 */

/** A runtime that can be asked what it can actually do. */
export type CapabilityRuntime = {
  /** Stable id for messages and audit ("local-demo", "worker-real", …). */
  runtime_id: string;
  /** Adapter ids the runtime has registered. */
  available: ReadonlySet<string>;
  /**
   * Modes each adapter genuinely implements. An adapter present but lacking a
   * `write` implementation must not satisfy a write step — that is how a write
   * silently degrades into a no-op that still reports success.
   */
  modes: ReadonlyMap<string, ReadonlySet<AgentStep["mode"]>>;
  /** Connector/permission prerequisites the runtime knows are unmet. */
  unmet_prerequisites?: ReadonlyMap<string, string>;
};

export type MissingCapability = {
  capability_id: string;
  step_id: string;
  /** Which of the checks failed — drives the message the user sees. */
  reason: "no_adapter" | "mode_unsupported" | "prerequisite_unmet" | "not_in_catalog";
  detail: string;
};

export type RuntimeReadiness = {
  ready: boolean;
  runtime_id: string;
  missing: MissingCapability[];
};

/**
 * Builds a runtime descriptor from an adapter registry, deriving supported
 * modes from which functions each adapter actually implements rather than from
 * what the catalog claims.
 */
export function runtimeFromRegistry(
  runtime_id: string,
  registry: ReadonlyMap<string, { read?: unknown; proposeWrite?: unknown; write?: unknown }>,
  unmet_prerequisites?: ReadonlyMap<string, string>,
): CapabilityRuntime {
  const modes = new Map<string, ReadonlySet<AgentStep["mode"]>>();
  for (const [id, adapter] of registry) {
    const implemented = new Set<AgentStep["mode"]>();
    if (typeof adapter.read === "function") implemented.add("read");
    if (typeof adapter.proposeWrite === "function") implemented.add("propose_write");
    if (typeof adapter.write === "function") implemented.add("write");
    modes.set(id, implemented);
  }
  return {
    runtime_id,
    available: new Set(registry.keys()),
    modes,
    ...(unmet_prerequisites ? { unmet_prerequisites } : {}),
  };
}

/**
 * Validates a spec against the runtime that will execute it. Call before
 * registration AND again immediately before execution — a connector can be
 * revoked between the two.
 */
export function validateRuntimeCapabilities(
  spec: Pick<AgentSpec, "steps">,
  runtime: CapabilityRuntime,
): RuntimeReadiness {
  const missing: MissingCapability[] = [];
  for (const step of spec.steps) {
    const id = step.capability_id;
    if (!getCapability(id)) {
      missing.push({
        capability_id: id,
        step_id: step.step_id,
        reason: "not_in_catalog",
        detail: `${id} is not a known capability`,
      });
      continue;
    }
    if (!runtime.available.has(id)) {
      missing.push({
        capability_id: id,
        step_id: step.step_id,
        reason: "no_adapter",
        detail: `${runtime.runtime_id} has no adapter for ${id}`,
      });
      continue;
    }
    const modes = runtime.modes.get(id);
    if (modes && !modes.has(step.mode)) {
      missing.push({
        capability_id: id,
        step_id: step.step_id,
        reason: "mode_unsupported",
        detail: `${id} on ${runtime.runtime_id} cannot ${step.mode.replace(/_/g, " ")}`,
      });
      continue;
    }
    const unmet = runtime.unmet_prerequisites?.get(id);
    if (unmet !== undefined) {
      missing.push({
        capability_id: id,
        step_id: step.step_id,
        reason: "prerequisite_unmet",
        detail: unmet,
      });
    }
  }
  return { ready: missing.length === 0, runtime_id: runtime.runtime_id, missing };
}

/** Error thrown instead of letting an undefined adapter reach the run engine. */
export class RuntimeCapabilityError extends Error {
  readonly missing: MissingCapability[];
  readonly runtime_id: string;
  constructor(readiness: RuntimeReadiness) {
    super(
      `cannot run on ${readiness.runtime_id}: ${readiness.missing.map((m) => m.detail).join("; ")}`,
    );
    this.name = "RuntimeCapabilityError";
    this.missing = readiness.missing;
    this.runtime_id = readiness.runtime_id;
  }
}

/**
 * Resolves the adapter for a step or throws a typed error. Replaces
 * `registry.get(step.capability_id)!`, whose non-null assertion was how
 * `undefined` reached the run engine.
 */
export function requireAdapter<A>(
  registry: ReadonlyMap<string, A>,
  step: AgentStep,
  runtime_id: string,
): A {
  const adapter = registry.get(step.capability_id);
  if (adapter === undefined) {
    throw new RuntimeCapabilityError({
      ready: false,
      runtime_id,
      missing: [
        {
          capability_id: step.capability_id,
          step_id: step.step_id,
          reason: "no_adapter",
          detail: `${runtime_id} has no adapter for ${step.capability_id}`,
        },
      ],
    });
  }
  return adapter;
}

/** One plain-language sentence naming what is missing and what it blocks. */
export function describeMissingCapabilities(missing: MissingCapability[]): string {
  if (missing.length === 0) return "";
  const first = missing[0]!;
  const rest = missing.length - 1;
  const lead =
    first.reason === "prerequisite_unmet"
      ? first.detail
      : `I don't have a way to do “${first.capability_id}” here`;
  return rest > 0 ? `${lead} (and ${rest} more step${rest === 1 ? "" : "s"})` : lead;
}
