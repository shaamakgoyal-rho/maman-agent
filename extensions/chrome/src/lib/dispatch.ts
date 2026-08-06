/**
 * Service-worker half of supervised actuation: pick the tab an approved action may
 * run in, spend its single-use token, and hand it to that tab's content script.
 *
 * Every browser API this needs is injected, so the whole decision — which tab,
 * whether the user is watching it, whether the token is still good — is testable
 * without a browser.
 */
import {
  browserActionRequestSchema,
  type BrowserActionRefusal,
  type BrowserActionRequest,
  type BrowserActionResult,
} from "@maman/contracts";
import { originOf, resolveRequest } from "@maman/browser-actuator";
import type { ActuationContext, ActuationOutput } from "./actuate.js";

export interface TabInfo {
  id: number;
  url: string;
  active: boolean;
  incognito: boolean;
  windowId: number;
}

export interface DispatchDeps {
  listTabs(): Promise<TabInfo[]>;
  isWindowFocused(windowId: number): Promise<boolean>;
  /** Domains the user granted observation for. Actuation never exceeds that grant. */
  enabledDomains(): Promise<string[]>;
  /** True when the run has been paused or cancelled from the desktop. */
  isRunPaused(runId: string): Promise<boolean>;
  /** Marks the token spent; false when it had already been used. */
  spendAuthorization(token: string): Promise<boolean>;
  sendToTab(
    tabId: number,
    request: BrowserActionRequest,
    ctx: ActuationContext,
  ): Promise<ActuationOutput>;
  navigate(tabId: number, url: string): Promise<void>;
  now(): Date;
}

export type DispatchOutput =
  { ok: true; result: BrowserActionResult } | { ok: false; error: "malformed_request" };

export async function dispatchBrowserAction(
  raw: unknown,
  deps: DispatchDeps,
): Promise<DispatchOutput> {
  const parsed = browserActionRequestSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "malformed_request" };
  const request = parsed.data;
  const now = deps.now();

  if (await deps.isRunPaused(request.run_id)) {
    return { ok: true, result: refusal(request, now, "paused_by_user", "") };
  }

  // Spent before anything else is attempted. One request means one attempt: if the
  // tab turns out to be gone, the token is still burned rather than left live for a
  // retry nobody approved.
  if (!(await deps.spendAuthorization(request.authorization))) {
    return { ok: true, result: refusal(request, now, "not_authorized", "") };
  }

  const enabled = await deps.enabledDomains();
  const tabs = await deps.listTabs();
  const candidates = tabs.filter(
    (t) =>
      isAllowed(originOf(t.url), request.allowed_origins) &&
      domainEnabled(originOf(t.url), enabled),
  );

  if (candidates.length === 0) {
    // Includes the case where the user has an allow-listed tab open but has not
    // enabled that domain. Maman also never opens a tab of its own: a run works
    // inside pages the user already has open on domains they enabled.
    return { ok: true, result: refusal(request, now, "origin_not_allowed", "") };
  }

  if (candidates.some((t) => t.incognito) && candidates.every((t) => t.incognito)) {
    return { ok: true, result: refusal(request, now, "private_window", "") };
  }
  const visible = candidates.filter((t) => !t.incognito);

  // Prefer the tab the user is actually looking at; that is also the tab that will
  // satisfy the presence gate for a write.
  let chosen = visible[0]!;
  let frontmost = false;
  for (const tab of visible) {
    const focused = tab.active && (await deps.isWindowFocused(tab.windowId));
    if (focused) {
      chosen = tab;
      frontmost = true;
      break;
    }
  }

  const ctx: ActuationContext = {
    origin: originOf(chosen.url),
    privateWindow: chosen.incognito,
    userPresent: frontmost,
    paused: false,
    authorizationValid: true,
  };

  if (request.action.kind === "navigate") {
    // The same gates run for a navigation, against a page with no controls: pause,
    // token, private window, and the destination origin.
    const resolved = resolveRequest(request, { ...ctx, controls: [] }, now, () => true);
    if (!resolved.ok) {
      return { ok: true, result: refusal(request, now, resolved.refusal, ctx.origin) };
    }
    await deps.navigate(chosen.id, request.action.url);
    return {
      ok: true,
      result: {
        schema_version: 1,
        type: "browser_action_result",
        request_id: request.request_id,
        run_id: request.run_id,
        step_id: request.step_id,
        outcome: "observed",
        observed: {
          resolved_name: "",
          value_after: request.action.url.slice(0, 512),
          match_count: 1,
          origin: ctx.origin,
        },
        completed_at: now.toISOString(),
      },
    };
  }

  return deps.sendToTab(chosen.id, request, ctx);
}

function isAllowed(origin: string, allowed: readonly string[]): boolean {
  return origin !== "" && allowed.some((a) => originOf(a) === origin);
}

/** The user's observation grant is per registrable domain; actuation reuses it. */
function domainEnabled(origin: string, enabled: readonly string[]): boolean {
  if (origin === "") return false;
  const host = new URL(origin).hostname;
  return enabled.some((d) => host === d || host.endsWith(`.${d}`));
}

function refusal(
  request: BrowserActionRequest,
  now: Date,
  reason: BrowserActionRefusal,
  origin: string,
): BrowserActionResult {
  return {
    schema_version: 1,
    type: "browser_action_result",
    request_id: request.request_id,
    run_id: request.run_id,
    step_id: request.step_id,
    outcome: "refused",
    refusal_reason: reason,
    ...(origin === "" ? {} : { observed: { resolved_name: "", match_count: 0, origin } }),
    completed_at: now.toISOString(),
  };
}
