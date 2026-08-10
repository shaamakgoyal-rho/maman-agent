import {
  describeGap,
  outstandingQuestions,
  resolveIntent,
  type AutomationIntent,
  type ResolvedIntent,
} from "@maman/intent-layer";
import type { BrowserControl } from "@maman/contracts";
import type { CapabilityContext } from "./adapters.js";
import {
  discoverSurface,
  type BrowserAdapterDeps,
  type DiscoveredSurface,
} from "./browser-adapters.js";

/**
 * RUN-TIME RESOLUTION: the agent looks at the page, then decides what it can do.
 *
 * The intent layer could already say what an automation needs and which of
 * those needs a live surface would answer — but nothing was doing the looking,
 * so `discovered_on_surface` never happened in production and a compiled
 * browser agent could not run at all. Its first step asked for `fields` that no
 * one had supplied, and threw "Teach the workflow which fields matter first."
 *
 * This is the other half. Discovery happens ONCE, before any step executes,
 * and the answer either binds the agent's inputs or stops the run. What it must
 * never do is let execution start on a partially-resolved intent: a run that
 * begins and then discovers it does not know which field to write is a run that
 * has already read the page and shown the user a proposal it cannot honour.
 */

export type SurfaceResolution =
  | {
      status: "ready";
      resolved: ResolvedIntent;
      surface: DiscoveredSurface;
      /**
       * Step inputs bound from what discovery found — the real accessible names
       * on the page in front of the user, not names anyone typed in.
       */
      fields: Array<{ name: string; nth?: number }>;
    }
  | {
      status: "needs_you";
      resolved: ResolvedIntent;
      surface: DiscoveredSurface;
      /** What the user must answer, in their own terms. */
      message: string;
      /** True when only the user can close the gap; false when the page can't. */
      answerable_by_user: boolean;
    }
  | {
      status: "could_not_look";
      /** Why the page could not be inspected. Never conflated with an empty page. */
      message: string;
    };

/** Controls the intent layer may consider. Secure fields are never candidates. */
function candidateControls(controls: readonly BrowserControl[]) {
  return (
    controls
      // A credential box is listed so the agent can SEE it and route around it.
      // Passing it on as a possible target would defeat the point of listing it.
      .filter((c) => !c.secure)
      .map((c) => ({
        name: c.name,
        role: c.role,
        // `duplicate_count > 1` is genuine ambiguity, and the intent layer refuses
        // ambiguity. Repeating the entry that many times is how a collapsed count
        // is turned back into the ambiguity it represents, so a name matching
        // twelve rows resolves to nothing rather than to the first row.
        ...(c.duplicate_count > 1 ? { duplicates: c.duplicate_count } : {}),
      }))
  );
}

/** Expands collapsed repeats so ambiguity survives into resolution. */
function expandDuplicates(
  controls: ReturnType<typeof candidateControls>,
): Array<{ name: string; role: BrowserControl["role"] }> {
  const out: Array<{ name: string; role: BrowserControl["role"] }> = [];
  for (const control of controls) {
    const copies = "duplicates" in control ? control.duplicates : 1;
    for (let i = 0; i < copies; i++) out.push({ name: control.name, role: control.role });
  }
  return out;
}

/**
 * Looks at the page, resolves the intent against what is really there, and
 * reports one of three honest answers: ready, needs you, or could not look.
 *
 * `supplied` carries what the user has already told the agent (the value to
 * write, typically). It outranks discovery, because a person's stated intent is
 * not something a page can overrule.
 */
export async function resolveIntentOnSurface(input: {
  intent: AutomationIntent;
  deps: BrowserAdapterDeps;
  ctx: CapabilityContext;
  supplied?: Readonly<Record<string, string>>;
  observedSemantics?: readonly string[];
}): Promise<SurfaceResolution> {
  let surface: DiscoveredSurface;
  try {
    surface = await discoverSurface(input.deps, input.ctx);
  } catch (cause) {
    // Reported, never swallowed into "nothing found". The distinction is the
    // whole reason the intent layer separates `not_looked_yet` from
    // `no_matching_control`.
    return {
      status: "could_not_look",
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }

  const resolved = resolveIntent(input.intent, {
    origin: surface.origin,
    surface: {
      looked: true,
      controls: expandDuplicates(candidateControls(surface.controls)),
    },
    ...(input.supplied ? { supplied: input.supplied } : {}),
    ...(input.observedSemantics ? { observed_semantics: input.observedSemantics } : {}),
  });

  if (!resolved.executable) {
    const questions = outstandingQuestions(resolved);
    return {
      status: "needs_you",
      resolved,
      surface,
      message: gapMessage(resolved, surface),
      answerable_by_user: questions.length > 0,
    };
  }

  return {
    status: "ready",
    resolved,
    surface,
    fields: resolved.filled.filter((f) => f.kind === "field").map((f) => ({ name: f.value })),
  };
}

/**
 * The gap, plus the one thing a truncated listing changes about it.
 *
 * "I looked and it isn't there" is only true if the looking was complete. When
 * the page had more controls than one listing carries, the honest sentence has
 * to say so — otherwise the user is told to configure a field that may be
 * sitting just past the cut.
 */
function gapMessage(resolved: ResolvedIntent, surface: DiscoveredSurface): string {
  const base = describeGap(resolved);
  const missedByTruncation =
    surface.truncated && resolved.unfilled.some((u) => u.reason === "no_matching_control");
  return missedByTruncation
    ? `${base} (this page has more fields than I can take in at once, so it may be there and I did not reach it)`
    : base;
}
