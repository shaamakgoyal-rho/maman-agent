import type { ProposedDiff } from "@maman/agent-runtime";
import {
  executeBrowserPlan,
  planBrowserWrites,
  planRevert,
  summarizePlan,
  type ExecuteContext,
  type ExecuteDeps,
  type ExecuteOutcome,
  type PlannedChange,
  type PlanResult,
  type PlanStep,
} from "@maman/browser-actuator";
import { uuidv7 } from "@maman/contracts";
import { invokeCommand, isTauri } from "./bridge.js";

/**
 * The desktop's browser lane: turn an approved diff into a plan, run it through
 * the signed native channel, and report exactly what happened.
 *
 * This lane is the FALLBACK. `capability-router` scores `api` above
 * `browser_extension`, and a failed API write never becomes a browser write on its
 * own. What lands here is work for a system with no usable API.
 */

/**
 * The labels these fields carry ON THE PAGE, which are not the internal field
 * keys the diff uses.
 *
 * A wrong entry here is safe in the way that matters: the executor refuses with
 * `no_match` and asks, rather than finding some other field and writing to it. It
 * is not safe in the sense of working, so it is worth getting right.
 */
const FIELD_LABELS: Record<string, string> = {
  owner: "Account Owner",
  employee_count: "Employees",
  website: "Website",
  segment: "Type",
};

/**
 * Origins a browser run may touch, taken from what the user typed in Settings.
 *
 * The user states the FULL origin, scheme included, and this only parses and
 * normalises it. Two reasons it works that way rather than deriving one from the
 * observation allowlist:
 *
 * - Writing to a site is a bigger grant than watching it, so it is a separate,
 *   explicit list. Naming the exact origin is the point, not friction.
 * - Origins are compared exactly, and a bare `salesforce.com` would not cover an
 *   org at `acme.my.salesforce.com`. Matching by suffix instead would be the wrong
 *   trade, because `salesforce.com.evil.test` ends with it too.
 *
 * Nothing here builds a URL out of parts: the desktop webview must contain no
 * absolute HTTP literals at all, which is a structural guard on every device→server
 * call originating in Rust.
 */
export function browserActuationOrigins(entries: readonly string[]): string[] {
  const origins: string[] = [];
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      continue; // not a URL — the scheme has to be stated, so there is nothing to guess
    }
    if (parsed.protocol !== "https:") continue; // plaintext is never actuated
    if (!origins.includes(parsed.origin)) origins.push(parsed.origin);
  }
  return origins;
}

/** A single-use authorization token: 256 bits of randomness as hex. */
export function mintAuthorization(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  // Hex, so it can never match a credential shape the contract rejects.
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface RecordScopedChanges {
  changes: PlannedChange[];
  /** Changes belonging to records that are not the one open in the browser. */
  deferred: number;
  /** Names of those records, so the user is told what was left alone. */
  deferred_records: string[];
}

/**
 * Narrows a diff to the record the user actually has open.
 *
 * A browser lane acts on the page in front of the user; it cannot visit four
 * records the way an API call can address four ids. Rather than plan changes that
 * would hit `no_match` on arrival, they are DEFERRED and counted, so the run can
 * say "2 of 4 applied, 2 are on other records" instead of half-failing.
 */
export function changesForRecord(diff: ProposedDiff, record: string): RecordScopedChanges {
  const changes: PlannedChange[] = [];
  const deferredRecords = new Set<string>();
  for (const change of diff.changes) {
    if (change.account_name !== record) {
      deferredRecords.add(change.account_name);
      continue;
    }
    const label = FIELD_LABELS[change.field];
    if (label === undefined) {
      // An unmapped field cannot be addressed by name. Deferring is honest;
      // guessing a label would risk writing to the wrong control.
      deferredRecords.add(change.account_name);
      continue;
    }
    changes.push({
      record: change.account_name,
      field_label: label,
      from: change.old_value,
      to: change.new_value,
    });
  }
  const planned = new Set(changes.map((c) => `${c.record}|${c.field_label}`));
  return {
    changes,
    deferred: diff.changes.length - planned.size,
    deferred_records: [...deferredRecords],
  };
}

/** The record a browser plan will act on: the first one the diff mentions. */
export function primaryRecord(diff: ProposedDiff): string | null {
  return diff.changes[0]?.account_name ?? null;
}

export interface BrowserPlanPreview {
  steps: PlanStep[];
  lines: string[];
  writes: number;
  record: string;
  deferred: number;
  deferred_records: string[];
}

/**
 * Builds the plan the user is asked to approve. Returns the refusal verbatim when
 * no plan can be made — a refusal names the offending change, which is more useful
 * to the user than a generic failure.
 */
export function previewBrowserPlan(
  diff: ProposedDiff,
  saveControl = "Save",
): { ok: true; preview: BrowserPlanPreview } | { ok: false; reason: string } {
  const record = primaryRecord(diff);
  if (record === null) return { ok: false, reason: "the diff proposed no changes" };

  const scoped = changesForRecord(diff, record);
  const planned: PlanResult = planBrowserWrites({
    changes: scoped.changes,
    save_control: saveControl,
  });
  if (!planned.ok) return { ok: false, reason: planned.detail };

  const summary = summarizePlan(planned.steps);
  return {
    ok: true,
    preview: {
      steps: planned.steps,
      lines: summary.lines,
      writes: summary.writes,
      record,
      deferred: scoped.deferred,
      deferred_records: scoped.deferred_records,
    },
  };
}

/** Wires the pure executor to the signed native channel. */
export function browserDispatchDeps(): ExecuteDeps {
  return {
    dispatch: async (request) => {
      if (!isTauri()) throw new Error("browser actuation needs the desktop app");
      return invokeCommand<unknown>("browser_action_dispatch", { request });
    },
    mintAuthorization,
    newRequestId: () => uuidv7(),
    now: () => new Date(),
  };
}

export interface BrowserLaneResult {
  outcome: ExecuteOutcome;
  /** What a revert would put back, from what the page actually held. */
  revertable: { change: PlannedChange; observed_before: string | undefined; wrote: string }[];
}

export async function runBrowserPlan(
  preview: BrowserPlanPreview,
  changes: readonly PlannedChange[],
  ctx: ExecuteContext,
  deps: ExecuteDeps = browserDispatchDeps(),
): Promise<BrowserLaneResult> {
  const outcome = await executeBrowserPlan(preview.steps, ctx, deps);

  // The value to restore comes from what the page HELD, not from what the diff
  // predicted it held. Those differ exactly when someone else got there first.
  const revertable = outcome.steps
    .filter((s) => s.write && s.change_index !== null && s.step_id.endsWith("-set"))
    .filter((s) => s.status === "applied" || s.status === "unverified")
    .flatMap((s) => {
      const change = changes[s.change_index as number];
      if (change === undefined) return [];
      return [
        {
          change,
          observed_before: s.observed?.value_before,
          wrote: change.to,
        },
      ];
    });

  return { outcome, revertable };
}

/**
 * Undoes what a run applied.
 *
 * A revert is itself a consequential write, so it goes through the same gate: the
 * caller must pass a context with a fresh approval. It is not an escape hatch that
 * skips the rules it was created by.
 */
export async function revertBrowserRun(
  revertable: BrowserLaneResult["revertable"],
  ctx: ExecuteContext,
  deps: ExecuteDeps = browserDispatchDeps(),
): Promise<{ ok: true; outcome: ExecuteOutcome } | { ok: false; reason: string }> {
  const planned = planRevert(revertable);
  if (!planned.ok) return { ok: false, reason: planned.detail };
  return { ok: true, outcome: await executeBrowserPlan(planned.steps, ctx, deps) };
}
