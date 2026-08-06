import {
  isBrowserWrite,
  type BrowserAction,
  type BrowserActionRefusal,
  type BrowserActionRequest,
  type BrowserTarget,
} from "@maman/contracts";
import type { CandidateControl, PageContext, ResolveOutcome } from "./types.js";

/**
 * Normalise an accessible name for comparison.
 *
 * Real forms decorate labels: "Close Date *", "Close date:", non-breaking spaces
 * from a layout grid. Those are presentation, so they are stripped. Case and
 * internal whitespace are normalised for the same reason.
 *
 * What is NOT done here is substring matching. "Delete" must not match "Delete all
 * records" — a looser comparison turns a refusal (`no_match`, which asks the user)
 * into a click on a control nobody named.
 */
export function normalizeName(raw: string): string {
  return raw
    .replace(/\u00a0/g, " ") // escaped: a literal NBSP here is invisible in review
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s*[:*]+$/, "")
    .trim()
    .toLowerCase();
}

export function namesMatch(target: string, candidate: string): boolean {
  return normalizeName(target) === normalizeName(candidate);
}

/** Controls that match the target's role and name, in document order. */
export function matchingControls(
  target: BrowserTarget,
  controls: readonly CandidateControl[],
): CandidateControl[] {
  return controls.filter(
    (c) => c.visible && c.role === target.role && namesMatch(target.name, c.accessibleName),
  );
}

/**
 * Is this action's target reachable and safe to act on?
 *
 * Checks are ordered cheapest-and-most-decisive first: user intent, then the
 * authorization, then the tab, then the page. That order also means a refusal
 * reports the strongest reason rather than the most specific one — a request
 * arriving at a private window is refused for being a private window, and never
 * gets far enough to reveal whether the field it wanted exists.
 *
 * `now` is passed in rather than read from the clock so expiry is testable.
 */
export function resolveRequest(
  request: BrowserActionRequest,
  page: PageContext,
  now: Date,
  isAuthorizationValid: (token: string) => boolean,
): ResolveOutcome {
  const refuse = (refusal: BrowserActionRefusal, matchCount = 0): ResolveOutcome => ({
    ok: false,
    refusal,
    matchCount,
  });

  if (page.paused) return refuse("paused_by_user");

  // Expired, unknown, and already-spent all collapse into one reason on purpose:
  // distinguishing them would tell a caller which tokens once existed.
  if (!isAuthorizationValid(request.authorization)) return refuse("not_authorized");
  if (Date.parse(request.expires_at) <= now.getTime()) return refuse("not_authorized");

  const write = isBrowserWrite(request.action);
  // A write that claims to be inconsequential is malformed, not merely mislabelled.
  // Treat it as unauthorised rather than trusting the flag over the verb.
  if (write && !request.consequential) return refuse("not_authorized");

  if (page.privateWindow) return refuse("private_window");

  if (request.action.kind === "navigate") {
    return originAllowed(originOf(request.action.url), request.allowed_origins)
      ? { ok: true, control: navigationPseudoControl(request.action.url), matchCount: 1 }
      : refuse("origin_not_allowed");
  }

  if (!originAllowed(page.origin, request.allowed_origins)) return refuse("origin_not_allowed");

  // Presence gates writes only; reading a page the user left open is harmless.
  if (write && !page.userPresent) return refuse("user_absent");

  const target = request.action.target;
  const matches = matchingControls(target, page.controls);
  const count = matches.length;

  let control: CandidateControl | undefined;
  if (target.nth === undefined) {
    // Ambiguity is refused, never resolved by taking the first hit. The plan has to
    // say which row it means.
    if (count > 1) return refuse("ambiguous_match", count);
    control = matches[0];
  } else {
    control = matches[target.nth];
  }
  if (control === undefined) return refuse("no_match", count);

  // Applies to reads as well as writes: a password field is never typed into and
  // never read out.
  if (control.secure) return refuse("secure_field", count);

  if (write && !control.editable) return refuse("target_not_editable", count);

  const preconditionRefusal = checkPreconditions(request.action, control);
  if (preconditionRefusal !== undefined) return refuse(preconditionRefusal, count);

  return { ok: true, control, matchCount: count };
}

/**
 * The second, independent statement of intent carried by write actions.
 * `confirm_name` must agree with the control that was actually resolved, and
 * `expect_current` with the value the field actually holds.
 */
function checkPreconditions(
  action: BrowserAction,
  control: CandidateControl,
): BrowserActionRefusal | undefined {
  if (action.kind === "click_control") {
    return namesMatch(action.confirm_name, control.accessibleName)
      ? undefined
      : "confirm_name_mismatch";
  }
  if (action.kind === "set_value" && action.expect_current !== undefined) {
    // A field the adapter could not read cannot satisfy a precondition. Failing
    // here means a stale plan stops instead of overwriting an unread value.
    return valuesMatch(action.expect_current, control.value) ? undefined : "precondition_failed";
  }
  return undefined;
}

/** Values compare on trimmed text; a missing value never satisfies a precondition. */
export function valuesMatch(expected: string, actual: string | undefined): boolean {
  if (actual === undefined) return false;
  return expected.trim() === actual.trim();
}

/**
 * Origin comparison is exact string equality on the origin, not a suffix or
 * hostname test. `https://evil-salesforce.com` and `https://x.salesforce.com.evil`
 * both defeat the looser versions.
 */
export function originAllowed(origin: string, allowed: readonly string[]): boolean {
  return allowed.some((a) => originOf(a) === origin && origin !== "");
}

/** Origin of a URL, or "" when it cannot be parsed — which never matches. */
export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/** Navigation has no control; this keeps the success shape uniform for the caller. */
function navigationPseudoControl(url: string): CandidateControl {
  return {
    role: "link",
    accessibleName: url,
    editable: false,
    secure: false,
    visible: true,
  };
}
