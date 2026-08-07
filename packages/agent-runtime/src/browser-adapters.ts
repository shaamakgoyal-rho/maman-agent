import {
  executeBrowserPlan,
  ownWindowDispatch,
  type ExecuteContext,
  type ExecuteDeps,
  type OwnWindowHost,
  type PlanStep,
  type StepOutcome,
} from "@maman/browser-actuator";
import type { BrowserAction } from "@maman/contracts";
import type { CapabilityAdapter, CapabilityContext, ProposedDiff } from "./adapters.js";

/**
 * The four browser capabilities, as REAL adapters.
 *
 * Until now they existed only in the catalog: the compiler could emit
 * `browser.propose_form_fill` and `browser.supervised_form_fill`, and no
 * registry implemented either, so a compiled agent either crashed on an
 * `undefined` adapter (fixed in 26d3929) or was correctly refused as
 * `needs_runtime`. These make them executable.
 *
 * WHAT LIVES HERE vs WHAT DOES NOT. This module maps the agent-runtime step
 * interface onto browser actions and nothing else. Every decision about whether
 * an action may happen — origin, user presence, secure fields, single-use
 * authorisation, preconditions, halt-on-first-failure — is already made by
 * `@maman/browser-actuator`, against plain data. Adding a rule here would put a
 * second, divergent copy of the safety model in the codebase.
 *
 * The transport is injected, so the same adapters run against Maman's own
 * browser window, a paired extension, or a test double.
 */

/** What the adapters need from the host to act at all. */
export interface BrowserAdapterDeps {
  /** Transport: Maman's own window, or any other `OwnWindowHost`. */
  host: OwnWindowHost;
  /** Origins the user has permitted for actuation. Empty ⇒ nothing runs. */
  allowedOrigins: readonly string[];
  /**
   * Whether the user is present and watching. A consequential browser write
   * requires it, and the value must be OBSERVED, not assumed — passing a
   * hardcoded `true` here would defeat the check rather than satisfy it.
   */
  userPresent: () => boolean;
  /**
   * Whether org/pack policy permits supervised browser writes at all. Stated by
   * the caller that holds the policy; the pure core refuses a consequential
   * write when it is false, so defaulting it to true here would silently remove
   * a policy gate.
   */
  allowSupervisedBrowserWrites: boolean;
  newRequestId: () => string;
  mintAuthorization: () => string;
  now?: () => Date;
}

/** A field the agent will read or fill, addressed the way a human would. */
export interface BrowserFieldTarget {
  /** Accessible name, e.g. "Phone" — what the user sees as the field's label. */
  name: string;
  /** Disambiguator when a page legitimately repeats a label. */
  nth?: number;
}

function deps(d: BrowserAdapterDeps): ExecuteDeps {
  return {
    dispatch: ownWindowDispatch(d.host),
    mintAuthorization: d.mintAuthorization,
    newRequestId: d.newRequestId,
    now: d.now ?? (() => new Date()),
  };
}

/**
 * Builds the execution context the pure core gates against.
 *
 * `userPresent` is called at THIS moment rather than captured earlier, so a plan
 * authorised while the user was watching cannot execute after they walked away.
 * Nothing here is defaulted to a permissive value: `allowSupervisedBrowserWrites`
 * and `approvalGranted` are passed in by the caller that actually knows, and a
 * read plan states them as false.
 */
function executeContext(
  d: BrowserAdapterDeps,
  ctx: CapabilityContext,
  write: { allowed: boolean; approved: boolean },
): ExecuteContext {
  return {
    runId: ctx.run_id,
    routedSource: "browser_extension",
    mode: ctx.mode,
    allowSupervisedBrowserWrites: write.allowed,
    approvalGranted: write.approved,
    userPresent: d.userPresent(),
    allowedOrigins: [...d.allowedOrigins],
  };
}

/** Throws if the agent's window is not showing anything. */
async function requireOrigin(d: BrowserAdapterDeps): Promise<string> {
  const origin = await d.host.currentOrigin();
  if (origin === null) {
    throw new Error("Maman's browser window is not open, so there is no page to act on.");
  }
  return origin;
}

/**
 * One read of one field, through the full authorisation path.
 *
 * Returns the step outcome rather than a value, because "I could not read it" is
 * information the callers need: a diff cannot promise what would change in a
 * field whose current value is unknown, and a blank is not the same as unknown.
 */
async function readField(
  d: BrowserAdapterDeps,
  target: BrowserFieldTarget,
  ctx: CapabilityContext,
): Promise<StepOutcome> {
  const action: BrowserAction = {
    kind: "read_field",
    target: {
      role: "textbox",
      name: target.name,
      ...(target.nth !== undefined ? { nth: target.nth } : {}),
    },
  };
  const step: PlanStep = {
    step_id: `read-${target.name}`,
    action,
    preview: `Read “${target.name}” from the open page`,
    change_index: null,
    write: false,
  };
  const outcome = await executeBrowserPlan(
    [step],
    executeContext(d, ctx, { allowed: false, approved: false }),
    deps(d),
  );
  const first = outcome.steps[0];
  if (!first) {
    throw new Error(`I could not read “${target.name}”: the action was not attempted.`);
  }
  return first;
}

/** The value a read actually observed, or undefined when it is unknown. */
function observedValue(outcome: StepOutcome): string | undefined {
  return outcome.status === "observed" ? outcome.observed?.value_after : undefined;
}

/**
 * The four adapters. `extract_table` is deliberately absent — see the note.
 */
export function browserAdapters(d: BrowserAdapterDeps): Map<string, CapabilityAdapter> {
  const registry = new Map<string, CapabilityAdapter>();

  /**
   * READ: the named fields on the page the window is showing.
   *
   * Inputs: `{ fields: BrowserFieldTarget[] }`. Values of secure fields are
   * never returned — the page script withholds them even when asked.
   */
  registry.set("browser.extract_structured_fields", {
    id: "browser.extract_structured_fields",
    read: async (inputs, ctx) => {
      const fields = normaliseFields(inputs["fields"]);
      if (fields.length === 0) {
        throw new Error(
          "No fields were configured to read. Teach the workflow which fields matter first.",
        );
      }
      const origin = await requireOrigin(d);
      const values: Record<string, string> = {};
      const unread: string[] = [];
      for (const field of fields) {
        const value = observedValue(await readField(d, field, ctx));
        if (value !== undefined) values[field.name] = value;
        // A field that could not be read is REPORTED, not silently omitted: a
        // caller comparing "before" values needs to know which are unknown.
        else unread.push(field.name);
      }
      return { origin, values, unread };
    },
  });

  /**
   * PROPOSE: exactly what would change, read from the live page.
   *
   * Inputs: `{ fields: Array<{ name, value, nth? }> }` — the values the workflow
   * wants set. Each field's CURRENT value is read first, so the diff is grounded
   * in the page as it is now rather than in what the plan assumed. A field
   * already holding the wanted value produces NO change: proposing a no-op write
   * would inflate the change count the user approves.
   */
  registry.set("browser.propose_form_fill", {
    id: "browser.propose_form_fill",
    proposeWrite: async (inputs, ctx): Promise<ProposedDiff> => {
      const wanted = normaliseFills(inputs["fields"]);
      if (wanted.length === 0) {
        throw new Error("No field values were configured, so there is nothing to propose.");
      }
      const origin = await requireOrigin(d);
      const changes: ProposedDiff["changes"] = [];
      let unreadable = 0;
      for (const field of wanted) {
        const result = await readField(d, field, ctx);
        const current = observedValue(result);
        if (current === undefined) {
          // Cannot see the current value ⇒ cannot promise what would change.
          // Skipped and counted, never guessed.
          unreadable += 1;
          continue;
        }
        if (current === field.value) continue; // already correct: no change
        changes.push({
          // The record this change belongs to: the page's own URL path, which is
          // the only record identity available without inventing one.
          account_id: origin,
          account_name: origin,
          field: field.name,
          old_value: current,
          new_value: field.value,
        });
      }
      return {
        summary: {
          input_rows: wanted.length,
          confident_matches: changes.length,
          ambiguous_skipped: unreadable,
          missing: 0,
          change_count: changes.length,
          accounts_affected: changes.length > 0 ? 1 : 0,
        },
        changes,
      };
    },
  });

  /**
   * WRITE: applies the APPROVED diff, one field at a time, then verifies.
   *
   * `expect_current` carries each change's `old_value`, so the write refuses if
   * the page changed after the user approved — the stale-diff case. The plan
   * halts on the first failure rather than pressing on, so a partial application
   * is reported as partial instead of retried into an unknown state.
   */
  registry.set("browser.supervised_form_fill", {
    id: "browser.supervised_form_fill",
    // A propose implementation is required for a write capability (the validator
    // enforces it): a write must always be previewable.
    proposeWrite: async (inputs, ctx) =>
      registry.get("browser.propose_form_fill")!.proposeWrite!(inputs, ctx),
    write: async (_inputs, approvedDiff, ctx) => {
      if (approvedDiff.changes.length === 0) {
        // Nothing approved ⇒ nothing written. Reporting success for an empty
        // write would let a run claim a change it never made.
        return { applied: 0, results: [] };
      }
      const steps: PlanStep[] = approvedDiff.changes.map((change, i) => ({
        step_id: `fill-${i + 1}-${change.field}`,
        action: {
          kind: "set_value",
          target: { role: "textbox", name: change.field },
          value: change.new_value,
          // OPTIMISTIC CONCURRENCY, taken from the approved diff itself: the
          // write refuses if the field no longer holds what the user was shown.
          expect_current: change.old_value,
        } satisfies BrowserAction,
        preview: `Set “${change.field}” to “${change.new_value}” (currently “${change.old_value}”)`,
        change_index: i,
        write: true,
      }));

      // The user approved THIS diff, so `approvalGranted` is true here and only
      // here. `allowSupervisedBrowserWrites` reflects the policy the caller
      // holds; it is never defaulted on.
      const outcome = await executeBrowserPlan(
        steps,
        executeContext(d, ctx, { allowed: d.allowSupervisedBrowserWrites, approved: true }),
        deps(d),
      );
      const applied = outcome.steps.filter((s) => s.status === "applied").length;
      return {
        applied,
        halted: outcome.steps.length < approvedDiff.changes.length,
        results: outcome.steps.map((s) => ({ step_id: s.step_id, status: s.status })),
      };
    },
    /**
     * INDEPENDENT READBACK. Re-reads each field from the page and compares with
     * what was approved. This is a fresh read, not the write's own report: a
     * write that reported success but did not land (a framework that ignored the
     * value, a field that reverted) fails here, which is the entire point.
     */
    verify: async (inputs, output, ctx) => {
      const proposal = inputs["proposal"] as ProposedDiff | undefined;
      const changes = proposal?.changes ?? [];
      if (changes.length === 0) {
        return { verified: false, detail: "nothing was proposed, so nothing could be verified" };
      }
      let confirmed = 0;
      const mismatched: string[] = [];
      for (const change of changes) {
        const value = observedValue(await readField(d, { name: change.field }, ctx));
        if (value === change.new_value) confirmed += 1;
        else mismatched.push(change.field);
      }
      const applied = (output as { applied?: number }).applied ?? 0;
      const verified = confirmed === changes.length && applied === changes.length;
      return {
        verified,
        detail: verified
          ? `independent re-read confirmed ${confirmed} of ${changes.length} field change(s)`
          : `independent re-read confirmed only ${confirmed} of ${changes.length}` +
            (mismatched.length > 0 ? ` — ${mismatched.join(", ")} did not hold the new value` : ""),
      };
    },
  });

  // browser.extract_table is NOT registered.
  //
  // The capability exists in the catalog, but extracting a table means deciding
  // what a row is, which cells are headers, and how much of a page may be pulled
  // out — decisions with real privacy weight (an unbounded table read is an
  // unbounded page read). Registering a half-answer would let the compiler emit
  // it and the runtime gate would then pass, which is worse than the gate
  // correctly refusing it today.

  return registry;
}

function normaliseFields(raw: unknown): BrowserFieldTarget[] {
  if (!Array.isArray(raw)) return [];
  const out: BrowserFieldTarget[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      out.push({ name: item });
      continue;
    }
    if (typeof item === "object" && item !== null) {
      const name = (item as { name?: unknown }).name;
      const nth = (item as { nth?: unknown }).nth;
      if (typeof name === "string" && name.length > 0) {
        out.push({ name, ...(typeof nth === "number" ? { nth } : {}) });
      }
    }
  }
  return out;
}

function normaliseFills(raw: unknown): Array<BrowserFieldTarget & { value: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<BrowserFieldTarget & { value: string }> = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const name = (item as { name?: unknown }).name;
    const value = (item as { value?: unknown }).value;
    const nth = (item as { nth?: unknown }).nth;
    if (typeof name === "string" && name.length > 0 && typeof value === "string") {
      out.push({ name, value, ...(typeof nth === "number" ? { nth } : {}) });
    }
  }
  return out;
}
