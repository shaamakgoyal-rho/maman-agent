import {
  browserActionResultSchema,
  isBrowserWrite,
  type BrowserActionRefusal,
  type BrowserActionRequest,
  type BrowserActionResult,
  type BrowserObservation,
} from "@maman/contracts";
import { authorizeIssue, MAX_AUTHORIZATION_WINDOW_MS, type IssueRefusal } from "./authorize.js";
import type { PlanStep } from "./plan.js";
import { verifyWrite } from "./verify.js";

/**
 * Runs an approved plan, one action at a time, and STOPS at the first step that
 * does not do what it said it would.
 *
 * Stopping rather than continuing is the whole design. The capability router marks
 * consequential browser steps `onFailure: "stop_and_ask_user"` with no fallback
 * sources, and this is where that is honoured: there is no retry, no alternative
 * route, and no "carry on with the rest of the plan". A half-applied change that
 * the user is told about is recoverable; one that the run papered over is not.
 */

/**
 * How long each request stays valid.
 *
 * Clamped to the authorization ceiling rather than merely documented as being
 * inside it: a window longer than `authorizeIssue` allows would make every single
 * request refuse with `expiry_window_too_long`, so lowering the ceiling has to pull
 * this down with it instead of silently breaking the lane.
 */
export const REQUEST_WINDOW_MS = Math.min(30_000, MAX_AUTHORIZATION_WINDOW_MS);

export interface ExecuteContext {
  runId: string;
  /** The lane the router selected. Anything else is a programming error. */
  routedSource: string;
  mode: "shadow" | "supervised" | "active";
  /** From pack/tenant policy. Never defaulted to true. */
  allowSupervisedBrowserWrites: boolean;
  /** A human approved this plan. */
  approvalGranted: boolean;
  userPresent: boolean;
  allowedOrigins: readonly string[];
}

export interface ExecuteDeps {
  /** Sends the request to the browser. The answer is untrusted and re-parsed. */
  dispatch(request: BrowserActionRequest): Promise<unknown>;
  /** A fresh single-use token, ≥32 chars and not secret-shaped. */
  mintAuthorization(): string;
  newRequestId(): string;
  now(): Date;
}

export type StepStatus =
  /** A write landed and read back correctly. */
  | "applied"
  /** A read succeeded. */
  | "observed"
  /** The browser declined. */
  | "refused"
  /** The browser tried and could not. */
  | "failed"
  /** The on-device gate declined to send it at all. */
  | "not_issued"
  /** The write was applied but could not be confirmed. */
  | "unverified"
  /** An earlier step halted the run before this one was reached. */
  | "skipped";

export interface StepOutcome {
  step_id: string;
  status: StepStatus;
  write: boolean;
  change_index: number | null;
  refusal_reason?: BrowserActionRefusal;
  issue_refusal?: IssueRefusal;
  observed?: BrowserObservation;
  /** Present when the browser's answer did not match the contract. */
  protocol_error?: string;
}

export interface ExecuteOutcome {
  steps: StepOutcome[];
  /** step_id of the step that stopped the run, or null if all of them ran. */
  halted_at: string | null;
  /** Why, in words the run can show the user. */
  halted_because: string | null;
  writes_applied: number;
  /** True only when every write that ran was confirmed by a read-back. */
  all_writes_verified: boolean;
}

function requestFor(
  step: PlanStep,
  ctx: ExecuteContext,
  deps: ExecuteDeps,
  authorization: string,
  now: Date,
): BrowserActionRequest {
  return {
    schema_version: 1,
    type: "browser_action_request",
    request_id: deps.newRequestId(),
    run_id: ctx.runId,
    step_id: step.step_id,
    action: step.action,
    authorization,
    allowed_origins: [...ctx.allowedOrigins] as [string, ...string[]],
    consequential: isBrowserWrite(step.action),
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + REQUEST_WINDOW_MS).toISOString(),
  };
}

export async function executeBrowserPlan(
  steps: readonly PlanStep[],
  ctx: ExecuteContext,
  deps: ExecuteDeps,
): Promise<ExecuteOutcome> {
  const outcomes: StepOutcome[] = [];
  const spent = new Set<string>();
  let haltedAt: string | null = null;
  let haltedBecause: string | null = null;
  let writesApplied = 0;
  let allVerified = true;

  for (const step of steps) {
    if (haltedAt !== null) {
      outcomes.push({
        step_id: step.step_id,
        status: "skipped",
        write: step.write,
        change_index: step.change_index,
      });
      continue;
    }

    const now = deps.now();
    const authorization = deps.mintAuthorization();

    // The on-device gate, before anything reaches the wire.
    const issue = authorizeIssue({
      routedSource: ctx.routedSource,
      action: step.action,
      mode: ctx.mode,
      allowSupervisedBrowserWrites: ctx.allowSupervisedBrowserWrites,
      approvalGranted: ctx.approvalGranted,
      userPresent: ctx.userPresent,
      allowedOrigins: ctx.allowedOrigins,
      authorization,
      spentAuthorizations: spent,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + REQUEST_WINDOW_MS),
    });
    if (!issue.ok) {
      outcomes.push({
        step_id: step.step_id,
        status: "not_issued",
        write: step.write,
        change_index: step.change_index,
        issue_refusal: issue.reason,
      });
      haltedAt = step.step_id;
      haltedBecause = `not sent: ${issue.reason}`;
      if (step.write) allVerified = false;
      continue;
    }
    spent.add(authorization);

    const request = requestFor(step, ctx, deps, authorization, now);

    let result: BrowserActionResult;
    try {
      const raw = await deps.dispatch(request);
      // The browser's answer is untrusted data even though the channel is signed:
      // the signature proves who sent it, not that it means anything.
      const parsed = browserActionResultSchema.safeParse(raw);
      if (!parsed.success) {
        outcomes.push({
          step_id: step.step_id,
          status: "failed",
          write: step.write,
          change_index: step.change_index,
          protocol_error: parsed.error.issues[0]?.message ?? "malformed result",
        });
        haltedAt = step.step_id;
        haltedBecause = "the browser's answer did not match the contract";
        if (step.write) allVerified = false;
        continue;
      }
      result = parsed.data;
    } catch (e) {
      // No relay, a timeout, or a transport error. NOT retried: a write that timed
      // out may well have landed, and sending it again could apply it twice.
      outcomes.push({
        step_id: step.step_id,
        status: "failed",
        write: step.write,
        change_index: step.change_index,
        protocol_error: e instanceof Error ? e.message : "dispatch failed",
      });
      haltedAt = step.step_id;
      haltedBecause = e instanceof Error ? e.message : "dispatch failed";
      if (step.write) allVerified = false;
      continue;
    }

    const observed = result.observed;
    const base = {
      step_id: step.step_id,
      write: step.write,
      change_index: step.change_index,
      ...(observed === undefined ? {} : { observed }),
    };

    // Keyed off the reason rather than the outcome: the contract cross-validates
    // that `refusal_reason` is present exactly when the outcome is "refused", so
    // checking the field that is actually used avoids a branch that cannot happen
    // and would never be exercised by a test.
    if (result.refusal_reason !== undefined) {
      outcomes.push({ ...base, status: "refused", refusal_reason: result.refusal_reason });
      haltedAt = step.step_id;
      haltedBecause = `the browser refused: ${result.refusal_reason}`;
      if (step.write) allVerified = false;
      continue;
    }
    if (result.outcome === "failed") {
      outcomes.push({
        ...base,
        status: "failed",
        ...(result.failure === undefined ? {} : { protocol_error: result.failure }),
      });
      haltedAt = step.step_id;
      haltedBecause = result.failure ?? "the browser could not perform the action";
      if (step.write) allVerified = false;
      continue;
    }

    if (!step.write) {
      outcomes.push({ ...base, status: "observed" });
      continue;
    }

    const verification = verifyWrite(step.action, result);
    if (verification.verified) {
      outcomes.push({ ...base, status: "applied" });
      writesApplied += 1;
      continue;
    }

    // A click has nothing to read back from itself; the plan's post-save reads are
    // what confirm it. That is not a failure, so the run continues.
    if (verification.reason === "requires_independent_read") {
      outcomes.push({ ...base, status: "applied" });
      writesApplied += 1;
      continue;
    }

    // The write went in but does not read back. Continuing would stack further
    // changes on top of a record whose state is not what the plan believes.
    outcomes.push({ ...base, status: "unverified" });
    writesApplied += 1;
    allVerified = false;
    haltedAt = step.step_id;
    haltedBecause = `the change did not read back (${verification.reason})`;
  }

  return {
    steps: outcomes,
    halted_at: haltedAt,
    halted_because: haltedBecause,
    writes_applied: writesApplied,
    all_writes_verified: allVerified,
  };
}

/**
 * What the post-save confirmation reads say about each change.
 *
 * Kept separate from `all_writes_verified` because they answer different
 * questions: that flag is about whether each write read back at the time, while
 * this is about whether the value survived being committed.
 */
export function confirmedChanges(
  outcome: ExecuteOutcome,
  expected: readonly string[],
): { change_index: number; confirmed: boolean }[] {
  return outcome.steps
    .filter((s) => s.step_id.endsWith("-confirm") && s.change_index !== null)
    .map((s) => {
      const index = s.change_index as number;
      const want = expected[index];
      const got = s.observed?.value_after;
      return {
        change_index: index,
        confirmed: s.status === "observed" && want !== undefined && got?.trim() === want.trim(),
      };
    });
}
