import type { BrowserAction, BrowserTargetRole } from "@maman/contracts";

/**
 * Turns an approved diff into an ordered list of browser actions.
 *
 * This is the part a human approves. It is pure and produces a `preview` line per
 * step for exactly that reason: "update 4 fields in Salesforce" is not something
 * anyone can consent to meaningfully, whereas "set Employees on Northwind Traders
 * from 120 to 340, then click Save" is.
 *
 * The plan is built ONCE, before approval, and is not recomputed afterwards. If
 * the page has moved on by the time it runs, each `set_value` carries the value it
 * expects to find and the executor refuses rather than overwriting — see
 * `resolveRequest`.
 */

export interface PlannedChange {
  /** Which record, for the preview and the receipt. Never used for targeting. */
  record: string;
  /** Accessible name of the field's control, as a person would read it. */
  field_label: string;
  /** Value the field must currently hold. A mismatch means the plan is stale. */
  from: string;
  to: string;
  /** Control kind. A picklist is a combobox and is set by choosing an option. */
  role?: BrowserTargetRole;
  /** Position when the same label repeats on the page, e.g. a table row. */
  nth?: number;
}

export interface PlanInput {
  changes: readonly PlannedChange[];
  /** Accessible name of the control that commits the form, when there is one. */
  save_control?: string;
}

export interface PlanStep {
  step_id: string;
  action: BrowserAction;
  /** One line a human can check against the page before approving. */
  preview: string;
  /** Index into `changes`, or null for the save click. */
  change_index: number | null;
  /** True for the steps that alter the remote system. */
  write: boolean;
}

/**
 * Why a plan was not produced. A refused plan is a normal outcome that asks the
 * user something, not an error to be worked around.
 */
export type PlanRefusal =
  /** Nothing to do. */
  | "no_changes"
  /** More changes than anyone can meaningfully review in one approval. */
  | "too_many_changes"
  /** A change with no field label cannot be targeted by name. */
  | "missing_field_label"
  /** `from` already equals `to`; writing it would be a change nobody asked for. */
  | "no_change_needed"
  /**
   * Two changes address the same control. Whichever ran second would silently
   * win, and only one of them is what the user saw.
   */
  | "duplicate_target";

export type PlanResult =
  { ok: true; steps: PlanStep[] } | { ok: false; reason: PlanRefusal; detail: string };

/**
 * Ceiling on one approval. Not a technical limit — a review limit. A plan larger
 * than this should be split so that what the user approves is what they read.
 */
export const MAX_PLAN_CHANGES = 50;

function targetOf(change: PlannedChange) {
  return {
    role: change.role ?? "textbox",
    name: change.field_label,
    ...(change.nth === undefined ? {} : { nth: change.nth }),
  };
}

export function planBrowserWrites(input: PlanInput): PlanResult {
  const { changes } = input;
  if (changes.length === 0) {
    return { ok: false, reason: "no_changes", detail: "the diff proposed no changes" };
  }
  if (changes.length > MAX_PLAN_CHANGES) {
    return {
      ok: false,
      reason: "too_many_changes",
      detail: `${changes.length} changes exceeds the ${MAX_PLAN_CHANGES} a single approval covers`,
    };
  }

  const seen = new Set<string>();
  for (const [index, change] of changes.entries()) {
    if (change.field_label.trim() === "") {
      return {
        ok: false,
        reason: "missing_field_label",
        detail: `change ${index} on ${change.record} has no field label`,
      };
    }
    if (change.from === change.to) {
      return {
        ok: false,
        reason: "no_change_needed",
        detail: `${change.field_label} on ${change.record} already reads "${change.to}"`,
      };
    }
    const key = `${change.role ?? "textbox"}|${change.field_label.trim().toLowerCase()}|${change.nth ?? ""}`;
    if (seen.has(key)) {
      return {
        ok: false,
        reason: "duplicate_target",
        detail: `two changes address ${change.field_label} on ${change.record}`,
      };
    }
    seen.add(key);
  }

  const steps: PlanStep[] = [];
  for (const [index, change] of changes.entries()) {
    const target = targetOf(change);
    const where = `"${change.field_label}" on ${change.record}`;

    // Read-only, and first: the field is brought into view so the user watching
    // sees where the change is about to happen rather than only its result.
    steps.push({
      step_id: `c${index}-focus`,
      action: { kind: "focus_field", target },
      preview: `Show ${where}`,
      change_index: index,
      write: false,
    });

    if (target.role === "combobox") {
      // `select_option` carries no `expect_current`, so a concurrent edit cannot be
      // PREVENTED here the way it is for a text field. Reading first at least
      // records what was there, so the change is revertible and the post-write
      // verification can tell that something else moved it.
      steps.push({
        step_id: `c${index}-before`,
        action: { kind: "read_field", target },
        preview: `Read ${where} before changing it`,
        change_index: index,
        write: false,
      });
      steps.push({
        step_id: `c${index}-set`,
        action: { kind: "select_option", target, option: change.to },
        preview: `Choose "${change.to}" for ${where} (was "${change.from}")`,
        change_index: index,
        write: true,
      });
    } else {
      steps.push({
        step_id: `c${index}-set`,
        action: {
          kind: "set_value",
          target,
          value: change.to,
          expect_current: change.from,
        },
        preview: `Set ${where}: "${change.from}" → "${change.to}"`,
        change_index: index,
        write: true,
      });
    }

    steps.push({
      step_id: `c${index}-verify`,
      action: { kind: "read_field", target },
      preview: `Read ${where} back`,
      change_index: index,
      write: false,
    });
  }

  if (input.save_control !== undefined && input.save_control.trim() !== "") {
    const name = input.save_control;
    steps.push({
      step_id: "save",
      action: {
        kind: "click_control",
        target: { role: "button", name },
        confirm_name: name,
      },
      preview: `Click "${name}"`,
      change_index: null,
      write: true,
    });
    // AFTER the save, not instead of the per-field read-back. The read before save
    // proves the form took the value; only a read after it proves the value
    // survived being committed.
    for (const [index, change] of changes.entries()) {
      steps.push({
        step_id: `c${index}-confirm`,
        action: { kind: "read_field", target: targetOf(change) },
        preview: `Confirm "${change.field_label}" on ${change.record} still reads "${change.to}"`,
        change_index: index,
        write: false,
      });
    }
  }

  return { ok: true, steps };
}

export interface PlanSummary {
  writes: number;
  reads: number;
  lines: string[];
}

/** What the approval panel shows. Every step, in the order it will happen. */
export function summarizePlan(steps: readonly PlanStep[]): PlanSummary {
  return {
    writes: steps.filter((s) => s.write).length,
    reads: steps.filter((s) => !s.write).length,
    lines: steps.map((s) => s.preview),
  };
}

/**
 * The plan that puts an applied change back.
 *
 * Built from what was OBSERVED rather than from the original plan: the value to
 * restore is the one the page actually held before the write, not the one the diff
 * predicted it held. Those differ exactly when something else had already changed
 * the record, which is the case where getting it wrong matters most.
 *
 * `expect_current` is the value that was written, so a revert refuses if a third
 * party has since changed the field again rather than clobbering their edit.
 */
export function planRevert(
  applied: readonly { change: PlannedChange; observed_before: string | undefined; wrote: string }[],
): PlanResult {
  const restorable = applied.filter(
    (a): a is (typeof applied)[number] & { observed_before: string } =>
      a.observed_before !== undefined && a.observed_before !== a.wrote,
  );
  if (restorable.length === 0) {
    return {
      ok: false,
      reason: "no_changes",
      detail: "nothing was applied that could be put back",
    };
  }
  // Reverse order: the last change made is the first undone, so a partially
  // applied run unwinds the way it wound up.
  return planBrowserWrites({
    changes: [...restorable].reverse().map((a) => ({
      ...a.change,
      from: a.wrote,
      to: a.observed_before,
    })),
  });
}
