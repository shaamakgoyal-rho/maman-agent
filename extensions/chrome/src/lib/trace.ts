import type {
  LocalActionTrace,
  ObservedAction,
  ProtectedSegment,
  StableTarget,
} from "@maman/contracts";
import { classifyField, type FieldDescriptor } from "./semantic.js";

/**
 * TURNING WATCHED INTERACTIONS INTO A REPLAYABLE TRACE.
 *
 * The semantic path (semantic.ts) answers "what kind of thing happened" and
 * deliberately keeps nothing that could address a control again. That is the
 * mining projection, and it is why the product used to follow "I learned your
 * workflow" with a form asking which field, which label, which value.
 *
 * This module answers the other question — "how would I do that again" —
 * building `ObservedAction`s with real locators and dataflow edges. It is pure:
 * it takes descriptions of interactions and returns a trace, so both the
 * content script and the tests exercise identical logic, and nothing here can
 * touch the DOM or the network.
 *
 * IT REUSES `classifyField` ON PURPOSE. Capture and tracing must never disagree
 * about what is off limits: if the semantic layer refuses a field, the trace
 * layer records a HOLE at that moment rather than a step. One classifier, one
 * answer, so a field cannot be denied for events and captured for traces.
 */

/** One interaction as the content script observed it. */
export type TraceObservation = {
  /** Monotonic ordering within the session. */
  at: string;
  kind: "click" | "commit" | "navigation" | "copy" | "paste" | "read";
  pageUrl: string;
  field?: FieldDescriptor;
  /** ARIA/implicit role of the target. */
  role?: string;
  /** The control's visible label — a label, never the data inside it. */
  accessibleName?: string;
  /** Stable developer identifier (id, name, data-testid). */
  identifier?: string;
  /** Enclosing landmark/section labels, outermost first. */
  ancestry?: string[];
  /**
   * Whether observation was refused at this moment, and why. The content script
   * sets this for private browsing, a password manager's injected UI, or an
   * auth/payment flow — surfaces where the hole itself is the honest record.
   */
  refused?: ProtectedSegment["reason"];
};

/** Origin + the SHAPE of the path — "/leads/:id", never the id itself. */
export function pathTemplate(rawUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length === 0) return "/";
  const templated = parts.map((part) => {
    // Anything that looks like an identifier becomes a placeholder: record ids,
    // uuids, and Salesforce-style 15/18-character keys are the customer's data,
    // not the shape of the workflow.
    if (/^\d+$/.test(part)) return ":id";
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(part)) return ":id";
    if (/^[a-zA-Z0-9]{15}$|^[a-zA-Z0-9]{18}$/.test(part)) return ":id";
    return part;
  });
  return `/${templated.join("/")}`;
}

/** The adapter-neutral verb for an observed interaction. */
function operationFor(kind: TraceObservation["kind"]): string {
  switch (kind) {
    case "commit":
      return "set_value";
    case "click":
      return "press";
    case "navigation":
      return "navigate";
    case "copy":
      return "read_field";
    case "paste":
      return "set_value";
    case "read":
      return "read_field";
  }
}

function targetFor(observation: TraceObservation): StableTarget {
  return {
    role: observation.role ?? "generic",
    ...(observation.accessibleName ? { accessible_name: observation.accessibleName } : {}),
    ...(observation.identifier ? { identifier: observation.identifier } : {}),
    ancestry: (observation.ancestry ?? []).slice(0, 12),
    menu_path: [],
  };
}

/**
 * One observation → a step, a hole, or nothing.
 *
 * A denied field yields `protected`, never a step: the trace says Maman looked
 * away, which is the honest record and stops the compiler from believing it saw
 * a complete routine.
 */
export function stepFrom(
  observation: TraceObservation,
  order: number,
):
  | { kind: "step"; step: ObservedAction }
  | { kind: "protected"; reason: ProtectedSegment["reason"] } {
  if (observation.refused) return { kind: "protected", reason: observation.refused };
  if (observation.field && classifyField(observation.field) === "deny") {
    return { kind: "protected", reason: "secure_field" };
  }

  const origin = (() => {
    try {
      return new URL(observation.pageUrl).origin;
    } catch {
      return undefined;
    }
  })();

  const writes = observation.kind === "commit" || observation.kind === "paste";
  const step: ObservedAction = {
    order,
    surface: "browser_dom",
    ...(origin ? { origin } : {}),
    ...(pathTemplate(observation.pageUrl)
      ? { path_template: pathTemplate(observation.pageUrl)! }
      : {}),
    operation: operationFor(observation.kind),
    target: targetFor(observation),
    // Resolved by `assembleTrace`, which can see the whole session; on its own
    // an interaction cannot know where its value came from.
    value_binding: { kind: "none" },
    preconditions: {
      requires_foreground: writes,
      requires_user_presence: writes,
    },
    ...(writes
      ? {
          expected_effect: { kind: "value_committed" as const, readback: "reread_target" as const },
        }
      : {}),
  };
  return { kind: "step", step };
}

/**
 * A whole session → one trace, with dataflow recovered.
 *
 * THE DATAFLOW RULE, and the reason this is not just a map():
 *  - A `paste` (or a commit right after a copy) takes its value FROM the step
 *    that copied it — the copy/paste edge, which is what makes a cross-app
 *    routine reproducible without ever storing what was copied.
 *  - Any other write has no inferable source, so it becomes a RUNTIME INPUT
 *    slot rather than a guess. That slot is what the pet asks about inline at
 *    the moment it is needed, which is how a one-click agent stays one click
 *    when a value is missing.
 *
 * Note what is never an option: keeping the typed text. There is no branch here
 * that could, because `TraceObservation` has nowhere to put it.
 */
export function assembleTrace(
  observations: readonly TraceObservation[],
  meta: { trace_id: string; apps: LocalActionTrace["apps"] },
): LocalActionTrace | null {
  const steps: ObservedAction[] = [];
  const protectedSegments: ProtectedSegment[] = [];
  /** The most recent step that READ something — a paste's likely source. */
  let lastRead: { order: number; output: string } | null = null;

  for (const observation of observations) {
    const result = stepFrom(observation, steps.length + 1);
    if (result.kind === "protected") {
      protectedSegments.push({
        started_at: observation.at,
        ended_at: observation.at,
        reason: result.reason,
      });
      // A hole breaks the dataflow chain: a value that crossed a protected
      // segment must not be treated as something an earlier step produced.
      lastRead = null;
      continue;
    }

    const step = result.step;
    if (observation.kind === "copy" || observation.kind === "read") {
      lastRead = {
        order: step.order,
        output: observation.accessibleName ?? observation.identifier ?? "value",
      };
    } else if (step.operation === "set_value") {
      step.value_binding = lastRead
        ? { kind: "from_step", step: lastRead.order, output: lastRead.output }
        : {
            kind: "runtime_input",
            input_id: (
              observation.accessibleName ??
              observation.identifier ??
              `input_${step.order}`
            )
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "_")
              .replace(/^_+|_+$/g, "")
              .slice(0, 48),
            prompt: observation.accessibleName
              ? `What should I put in ${observation.accessibleName}?`
              : "What value should I use here?",
          };
      // A value is consumed once: two pastes from one copy is a different
      // routine than a chain, and guessing wrong here fabricates dataflow.
      lastRead = null;
    }
    steps.push(step);
  }

  if (steps.length === 0) return null;
  return {
    schema_version: 1,
    trace_id: meta.trace_id,
    started_at: observations[0]!.at,
    ended_at: observations[observations.length - 1]!.at,
    apps: meta.apps,
    steps,
    protected_segments: protectedSegments,
    pattern_event_refs: [],
    local_only: true,
  };
}

/**
 * A WORK SESSION, buffered until it is worth sending.
 *
 * A content script's life is one page, but a routine crosses pages and apps, so
 * observations accumulate here and flush on a boundary the caller decides
 * (idle, page hide, or a cap). Keeping this out of content.ts is deliberate:
 * the DOM glue stays untestable-but-trivial, and every rule that decides what
 * leaves the page is exercised by tests.
 *
 * The cap is a safety valve, not a tuning knob — an unbounded buffer in a page
 * that never navigates is a memory leak with the user's work in it.
 */
export const MAX_SESSION_OBSERVATIONS = 200;

export class TraceSession {
  private observations: TraceObservation[] = [];

  constructor(private readonly newTraceId: () => string) {}

  /** Whether anything worth flushing has accumulated. */
  get size(): number {
    return this.observations.length;
  }

  /**
   * Records one observation. Returns true when the caller should flush now
   * because the cap is reached — the session never flushes itself, so a caller
   * cannot be surprised by network activity inside a DOM handler.
   */
  push(observation: TraceObservation): boolean {
    if (this.observations.length >= MAX_SESSION_OBSERVATIONS) {
      // Drop the OLDEST, not the newest: the recent steps are the ones a
      // routine is most likely still building toward.
      this.observations.shift();
    }
    this.observations.push(observation);
    return this.observations.length >= MAX_SESSION_OBSERVATIONS;
  }

  /**
   * Assembles and clears. Returns null when nothing survived capture — a
   * session of nothing but refused fields produces no trace at all, rather than
   * an empty shell that would read as "Maman watched and saw nothing happen".
   */
  flush(apps: LocalActionTrace["apps"]): LocalActionTrace | null {
    if (this.observations.length === 0) return null;
    const trace = assembleTrace(this.observations, { trace_id: this.newTraceId(), apps });
    this.observations = [];
    return trace;
  }
}
