import { browserActionResultSchema, type BrowserActionRequest } from "@maman/contracts";
import { buildEvalExpression, isHostAction, parseAgentEnvelope } from "./inpage.js";
import type { ExecuteDeps } from "./execute.js";

/**
 * THE OWN-WINDOW TRANSPORT.
 *
 * `ExecuteDeps.dispatch` was already transport-agnostic, so giving the agent its
 * own browser is a new dispatch rather than a new architecture. Two transports
 * now exist behind the same pure core:
 *
 *   extension  → Chrome, via native messaging to a paired content script
 *   own_window → Maman's own window, via one evaluated expression per action
 *
 * The own-window transport removes the dependencies that made the browser lane
 * unreachable in practice: no unpacked extension, no native-messaging manifest
 * keyed to an extension id that changes with its path, no per-site permission
 * prompt, and no API keys, connected apps or token vault. The user signs into a
 * site once in a window they can see; the cookie store persists with the app.
 *
 * The host (Rust) supplies exactly two primitives. Everything else — which
 * action is allowed, in what order, bound to which approval — stays in the pure
 * core above this layer.
 */
export interface OwnWindowHost {
  /**
   * Evaluates an expression in the agent's window and resolves with whatever it
   * returned. MUST reject rather than resolve on eval failure, so a broken
   * bridge is a failure and never a silent "no change".
   */
  evaluate(expression: string): Promise<unknown>;
  /**
   * Navigates the window and resolves when the document is ready. Navigation is
   * a HOST action on purpose: a page must not be able to move itself as part of
   * an agent action, so the page script refuses `navigate` outright.
   */
  navigate(url: string): Promise<void>;
  /**
   * The origin the window is currently showing, read from the host's own view of
   * the webview — never from the page. `document.location` is page-controlled;
   * trusting it would let a page lie about where it is and defeat the origin
   * allowlist. Returns null when nothing is loaded.
   */
  currentOrigin(): Promise<string | null>;
}

/** Why a dispatch never reached the page at all. */
export class OwnWindowTransportError extends Error {
  constructor(
    readonly reason: "no_window" | "origin_mismatch" | "bridge_failed",
    detail: string,
  ) {
    super(`${reason}: ${detail}`);
    this.name = "OwnWindowTransportError";
  }
}

/**
 * Builds a `dispatch` for the pure executor that drives Maman's own window.
 *
 * The origin re-check here is not redundant with the core's check. The core
 * validated the origin when the plan was authorised; this validates it at the
 * instant of the action, against the HOST's view of the webview. Between those
 * two moments a page can navigate itself — a redirect, a meta refresh, a link
 * the previous action clicked — and without this the next write would land on
 * whatever page happened to be there.
 */
export function ownWindowDispatch(host: OwnWindowHost): ExecuteDeps["dispatch"] {
  return async (request: BrowserActionRequest): Promise<unknown> => {
    const origin = await host.currentOrigin();
    if (origin === null) {
      throw new OwnWindowTransportError("no_window", "the agent's browser window is not open");
    }
    if (!request.allowed_origins.includes(origin)) {
      // Fail closed and name both sides: an origin drift is the interesting
      // case, and a silent refusal would look like a missing target.
      throw new OwnWindowTransportError(
        "origin_mismatch",
        `window is on ${origin}, which this action does not allow`,
      );
    }

    // Correlation the contract requires on every result: an answer that cannot
    // be tied back to its run and step is not auditable, and the receipt could
    // not prove which step it belonged to.
    const correlation = {
      schema_version: 1 as const,
      type: "browser_action_result" as const,
      request_id: request.request_id,
      run_id: request.run_id,
      step_id: request.step_id,
    };

    if (isHostAction(request.action)) {
      // navigate: the host performs it, then reports the resulting origin. The
      // answer is synthesised here rather than by the page, because the page is
      // not a party to its own navigation.
      if (request.action.kind !== "navigate") {
        throw new OwnWindowTransportError("bridge_failed", "unexpected host action");
      }
      const target = new URL(request.action.url).origin;
      if (!request.allowed_origins.includes(target)) {
        throw new OwnWindowTransportError(
          "origin_mismatch",
          `navigation target ${target} is not in the allowed origins`,
        );
      }
      await host.navigate(request.action.url);
      const landed = await host.currentOrigin();
      if (landed !== target) {
        // A redirect took us somewhere else. That is a refusal, not a success:
        // continuing would run the rest of the plan on an unexpected site.
        return {
          ...correlation,
          completed_at: new Date().toISOString(),
          outcome: "refused",
          refusal_reason: "origin_not_allowed",
        };
      }
      return { ...correlation, completed_at: new Date().toISOString(), outcome: "observed" };
    }

    let raw: unknown;
    try {
      raw = await host.evaluate(buildEvalExpression(request));
    } catch (cause) {
      // A bridge that throws must surface as a failure. Swallowing it would
      // report "nothing changed" for an action whose real outcome is unknown —
      // the one state a write path must never invent.
      throw new OwnWindowTransportError(
        "bridge_failed",
        cause instanceof Error ? cause.message : String(cause),
      );
    }

    const envelope = parseAgentEnvelope(raw, request.request_id);
    // Re-shaped into the wire contract, then validated by the caller's own
    // schema parse. The page's answer is data at every hop.
    return {
      ...correlation,
      completed_at: new Date().toISOString(),
      outcome: envelope.outcome,
      ...(envelope.refusal_reason ? { refusal_reason: envelope.refusal_reason } : {}),
      ...(envelope.observed
        ? {
            observed: {
              // `resolved_name` and `match_count` are required by the contract:
              // an observation that cannot say WHAT it acted on, or how many
              // controls matched, cannot explain an ambiguous match afterwards.
              resolved_name: envelope.observed.accessible_name ?? "",
              match_count: envelope.observed.match_count ?? 1,
              ...(envelope.observed.value_before !== undefined
                ? { value_before: envelope.observed.value_before }
                : {}),
              ...(envelope.observed.value_after !== undefined
                ? { value_after: envelope.observed.value_after }
                : {}),
              // The origin comes from the HOST, never the page — the page could
              // otherwise attribute its own actions to a site it is not on.
              origin,
            },
          }
        : {}),
    };
  };
}

/**
 * Parses a dispatch answer into the contract type, or throws. Kept next to the
 * transport so both transports converge on the same validation.
 */
export function parseActionResult(raw: unknown) {
  return browserActionResultSchema.parse(raw);
}
