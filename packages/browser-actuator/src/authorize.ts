import { isBrowserWrite, type BrowserAction } from "@maman/contracts";

/**
 * Issue-side gate: may the desktop core send this action to the browser at all?
 *
 * `resolveRequest` is the extension's half — it decides whether a request that has
 * already arrived may touch a given page. This is the other half, and it runs
 * first, on device, before anything is put on the wire. Both are needed: the
 * extension cannot see the run's policy or approvals, and the core cannot see the
 * page.
 */

export type IssueRefusal =
  /** The router chose a different lane; only `browser_extension` comes through here. */
  | "wrong_source"
  /** Shadow runs prove value without touching the system. They never write. */
  | "shadow_run_never_writes"
  /** Pack/tenant policy has not enabled supervised browser writes. */
  | "policy_forbids_browser_writes"
  /** No human approved this specific step. */
  | "approval_missing"
  /** Nobody is at the machine to see what happens. */
  | "user_absent"
  /** This token was already used; a request may be performed at most once. */
  | "authorization_reused"
  /** Token too short to be worth anything. */
  | "authorization_too_weak"
  /** A long validity window is a long replay window. */
  | "expiry_window_too_long"
  /** Nothing to check the tab's origin against. */
  | "no_allowed_origins";

export interface IssueInput {
  /** `capabilitySource` chosen by the capability router for this step. */
  routedSource: string;
  action: BrowserAction;
  /** Run mode. Writes are only issued from supervised or active runs. */
  mode: "shadow" | "supervised" | "active";
  /** From pack/tenant policy — never inferred, never defaulted to true. */
  allowSupervisedBrowserWrites: boolean;
  /** A human approved THIS step, not the run in general. */
  approvalGranted: boolean;
  userPresent: boolean;
  allowedOrigins: readonly string[];
  authorization: string;
  /** Tokens already spent on this run. */
  spentAuthorizations: ReadonlySet<string>;
  issuedAt: Date;
  expiresAt: Date;
}

/** Longest validity a request may carry. Approval is immediate; the window is not. */
export const MAX_AUTHORIZATION_WINDOW_MS = 120_000;

/** Matches the lower bound in `browserActionRequestSchema.authorization`. */
export const MIN_AUTHORIZATION_LENGTH = 32;

export function authorizeIssue(
  input: IssueInput,
): { ok: true } | { ok: false; reason: IssueRefusal } {
  const deny = (reason: IssueRefusal) => ({ ok: false as const, reason });

  if (input.routedSource !== "browser_extension") return deny("wrong_source");
  if (input.allowedOrigins.length === 0) return deny("no_allowed_origins");
  if (input.authorization.length < MIN_AUTHORIZATION_LENGTH) return deny("authorization_too_weak");
  if (input.spentAuthorizations.has(input.authorization)) return deny("authorization_reused");

  const windowMs = input.expiresAt.getTime() - input.issuedAt.getTime();
  if (windowMs > MAX_AUTHORIZATION_WINDOW_MS) return deny("expiry_window_too_long");

  if (isBrowserWrite(input.action)) {
    // Three independent conditions, all required. None of them implies another:
    // policy is the tenant's standing decision, approval is this step's, and
    // presence is a fact about right now.
    if (input.mode === "shadow") return deny("shadow_run_never_writes");
    if (!input.allowSupervisedBrowserWrites) return deny("policy_forbids_browser_writes");
    if (!input.approvalGranted) return deny("approval_missing");
    if (!input.userPresent) return deny("user_absent");
  }

  return { ok: true };
}
