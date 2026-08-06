/**
 * Content-script half of supervised actuation: take a request that has already
 * been authenticated over the signed native channel, decide against the live page
 * whether it may run, run it, and report what happened.
 *
 * The decision itself is not made here — `resolveRequest` from
 * `@maman/browser-actuator` makes it, against DOM-free shapes, so it is testable
 * without a page. This file collects those shapes, applies the one action that was
 * allowed, and sanitises what it read before any of it leaves the page.
 */
import {
  browserActionRequestSchema,
  isBrowserWrite,
  looksLikeSecret,
  type BrowserActionRefusal,
  type BrowserActionRequest,
  type BrowserActionResult,
} from "@maman/contracts";
import { resolveRequest, type PageContext } from "@maman/browser-actuator";
import { applyAction, collectControls } from "./dom-adapter.js";

export interface ActuationContext {
  origin: string;
  privateWindow: boolean;
  /**
   * Browser-side evidence that the user is watching: the tab is active in a
   * focused window. This is deliberately NOT the desktop's idle timer — the core
   * already checked that before issuing. What this adds is that the page being
   * changed is the page in front of the user.
   */
  userPresent: boolean;
  paused: boolean;
  /** The service worker's verdict on the single-use token. See `sw.ts`. */
  authorizationValid: boolean;
}

export type ActuationOutput =
  { ok: true; result: BrowserActionResult } | { ok: false; error: "malformed_request" };

/** Contract bound on observed values. Longer page text is clipped, never dropped. */
const MAX_OBSERVED = 512;

/**
 * Page text is data, and this is the last point before it becomes wire, log, and
 * receipt. Two things happen to it: it is clipped to what the contract allows, and
 * anything secret-shaped is replaced outright. A field that happens to hold a token
 * must not put that token on the wire merely because someone read the field.
 */
export function sanitizeObserved(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (looksLikeSecret(value)) return "[redacted: secret-shaped value]";
  return value.length > MAX_OBSERVED ? value.slice(0, MAX_OBSERVED) : value;
}

export function executeBrowserAction(
  raw: unknown,
  ctx: ActuationContext,
  doc: Document,
  now: Date,
): ActuationOutput {
  // Untrusted input, even having come over a signed channel: the envelope proves
  // who sent it, not that the contents are well formed.
  const parsed = browserActionRequestSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "malformed_request" };
  const request = parsed.data;

  if (request.action.kind === "navigate") {
    // Navigation belongs to the service worker, which owns the tab. A navigate
    // reaching a content script means the plumbing is wrong, and pretending
    // otherwise would report a navigation that never happened.
    return {
      ok: true,
      result: failed(request, now, "navigate is performed by the service worker"),
    };
  }

  const bindings = collectControls(doc);
  const page: PageContext = {
    origin: ctx.origin,
    privateWindow: ctx.privateWindow,
    userPresent: ctx.userPresent,
    paused: ctx.paused,
    controls: bindings.map((b) => b.control),
  };

  const resolved = resolveRequest(request, page, now, () => ctx.authorizationValid);
  if (!resolved.ok) {
    return { ok: true, result: refused(request, now, resolved.refusal, resolved.matchCount, ctx) };
  }

  const binding = bindings.find((b) => b.control === resolved.control);
  if (binding === undefined) {
    // resolveRequest returns a control taken from the array it was given, so this
    // is unreachable — reported rather than asserted so a future refactor that
    // breaks the invariant fails loudly instead of acting on the wrong element.
    return { ok: true, result: failed(request, now, "resolved control lost its binding") };
  }

  const valueBefore = resolved.control.value;
  let valueAfter: string | undefined;
  try {
    ({ valueAfter } = applyAction(request.action, binding.element));
  } catch {
    // Page scripts can throw from a setter or a click handler. That is a failed
    // action, not a refused one, and it is never retried automatically.
    return { ok: true, result: failed(request, now, "the page threw while applying the action") };
  }

  const observedBefore = sanitizeObserved(valueBefore);
  const observedAfter = sanitizeObserved(valueAfter);

  return {
    ok: true,
    result: {
      schema_version: 1,
      type: "browser_action_result",
      request_id: request.request_id,
      run_id: request.run_id,
      step_id: request.step_id,
      outcome: isBrowserWrite(request.action) ? "applied" : "observed",
      observed: {
        resolved_name: sanitizeObserved(resolved.control.accessibleName)?.slice(0, 120) ?? "",
        ...(observedBefore === undefined ? {} : { value_before: observedBefore }),
        ...(observedAfter === undefined ? {} : { value_after: observedAfter }),
        match_count: resolved.matchCount,
        origin: ctx.origin,
      },
      completed_at: now.toISOString(),
    },
  };
}

function refused(
  request: BrowserActionRequest,
  now: Date,
  reason: BrowserActionRefusal,
  matchCount: number,
  ctx: ActuationContext,
): BrowserActionResult {
  return {
    schema_version: 1,
    type: "browser_action_result",
    request_id: request.request_id,
    run_id: request.run_id,
    step_id: request.step_id,
    outcome: "refused",
    refusal_reason: reason,
    // No control identity is reported on a refusal: a refused request should not
    // become a way to read the page. Only the count, which explains `ambiguous_match`.
    observed: {
      resolved_name: "",
      match_count: matchCount,
      origin: ctx.origin,
    },
    completed_at: now.toISOString(),
  };
}

function failed(request: BrowserActionRequest, now: Date, failure: string): BrowserActionResult {
  return {
    schema_version: 1,
    type: "browser_action_result",
    request_id: request.request_id,
    run_id: request.run_id,
    step_id: request.step_id,
    outcome: "failed",
    failure,
    completed_at: now.toISOString(),
  };
}
