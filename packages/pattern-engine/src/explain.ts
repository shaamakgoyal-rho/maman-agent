import {
  capabilitiesForToken,
  getCapability,
  CONTEXT_EVENT_TYPES,
} from "@maman/capability-catalog";

/**
 * Per-step explanation of an observed workflow: exactly what was seen, and
 * exactly what a helper would do about it. This is the precision layer the
 * suggestion card was missing — the deduped evidence list ("Work in · the
 * browser") could not tell the reader WHICH of their habits was detected or
 * WHICH steps a helper would take over.
 *
 * Deterministic and derived strictly from the canonical token sequence plus
 * the capability catalog. Every claim traces to one of those two sources:
 * the observed phrase comes from the token's own event type and AX role, and
 * the automation verdict comes from `capabilitiesForToken` — the SAME lookup
 * feasibility scoring uses, so the card can never claim automation the
 * engine didn't score. Nothing here invents an app, an object, or an intent.
 */

export type AutomationStep = {
  capability_id: string;
  /** Human capability name from the catalog, e.g. "Propose a form fill". */
  action: string;
  /** How it would run. `write` is always approval-gated (compiler + policy). */
  mode: "read" | "propose_write" | "write";
  needs_approval: boolean;
  reversible: boolean;
};

export type StepAutomation =
  /** A helper can do this step; the chain lists what it would do, in order. */
  | { kind: "automated"; steps: AutomationStep[] }
  /** Context, not work (app/window switches) — nothing to automate. */
  | { kind: "context"; note: string }
  /** Real work with no safe capability — it stays with the user. */
  | { kind: "manual"; note: string };

export type ObservedStepExplanation = {
  /** 1-based position in the observed sequence (after collapsing repeats). */
  order: number;
  /** What was observed, role-aware: "you change the value of a text field". */
  observed: string;
  /** Where: "the browser", "Salesforce", … */
  app: string;
  /** Consecutive identical steps collapsed; 3 means "this happens 3× in a row". */
  repeats: number;
  automation: StepAutomation;
};

export type WorkflowExplanation = {
  steps: ObservedStepExplanation[];
  /** Steps a helper would perform (automated), out of all non-context steps. */
  automated_count: number;
  work_step_count: number;
  /** True when every automated step only reads. */
  read_only: boolean;
  /** True when any automated step can write (always approval-gated). */
  has_writes: boolean;
};

const APP_LABELS: Record<string, string> = {
  crm: "Salesforce",
  spreadsheet: "your spreadsheet",
  email: "Gmail",
  calendar: "Calendar",
  research: "research tools",
  browser: "the browser",
  other: "an app I couldn't identify",
};

/**
 * Roles as nouns. The role is the most precise thing the observer records
 * about a step's target (it never records the content), so the explanation
 * uses it: "a text field" tells the reader which habit this is far better
 * than "a field". Two vocabularies feed this: the macOS AX observer emits
 * AX-prefixed roles, and the Chrome relay emits lowercase ARIA-style roles.
 */
const ROLE_NOUNS: Record<string, string> = {
  // macOS AX observer
  AXTextField: "a text field",
  AXTextArea: "a text area",
  AXStaticText: "a block of text",
  AXGroup: "a section of the page",
  AXButton: "a button",
  AXCell: "a table cell",
  AXRow: "a table row",
  AXColumn: "a table column",
  AXTable: "a table",
  AXLink: "a link",
  AXPopUpButton: "a dropdown",
  AXComboBox: "a combo box",
  AXCheckBox: "a checkbox",
  AXRadioButton: "a radio button",
  AXMenuItem: "a menu item",
  AXList: "a list",
  AXImage: "an image",
  AXWebArea: "a web page",
  AXWindow: "a window",
  // Chrome relay (ARIA-style)
  textbox: "a text field",
  textarea: "a text area",
  input: "an input field",
  field: "a field",
  searchbox: "a search box",
  combobox: "a combo box",
  checkbox: "a checkbox",
  cell: "a spreadsheet cell",
  row: "a table row",
  grid: "a grid",
  table: "a table",
  button: "a button",
  link: "a link",
};

/** Roles whose value a USER edits; value_committed on anything else is the
 * page updating itself while the user works, and must not be described as
 * the user typing. */
const EDITABLE_ROLES = new Set([
  // macOS AX observer
  "AXTextField",
  "AXTextArea",
  "AXComboBox",
  "AXCheckBox",
  "AXRadioButton",
  "AXPopUpButton",
  "AXCell",
  // Chrome relay (ARIA-style)
  "textbox",
  "textarea",
  "input",
  "field",
  "searchbox",
  "combobox",
  "checkbox",
  "cell",
]);

function roleNoun(role: string): string | null {
  if (!role || role === "-") return null;
  if (ROLE_NOUNS[role]) return ROLE_NOUNS[role];
  // Unknown AX role: strip the prefix and humanize rather than showing "AXFoo".
  const stripped = role.replace(/^AX/, "").replace(/([a-z])([A-Z])/g, "$1 $2");
  return `a ${stripped.toLowerCase()}`;
}

/** Observed phrase for one token, role-aware and honest about agency. */
function observedPhrase(eventType: string, role: string, semantic: string): string {
  const noun = roleNoun(role);
  const withSemantic = (base: string): string =>
    semantic && semantic !== "-" ? `${base} (${semantic.replace(/_/g, " ")})` : base;

  switch (eventType) {
    case "element_focused":
      return withSemantic(noun ? `you focus ${noun}` : "you focus part of the screen");
    case "value_committed":
      if (noun && EDITABLE_ROLES.has(role)) {
        return withSemantic(`you change the value of ${noun}`);
      }
      // Not something a user edits: the page changed while they worked.
      return withSemantic(noun ? `${noun} updates` : "something on the screen updates");
    case "element_activated":
      return withSemantic(noun ? `you activate ${noun}` : "you run a search");
    case "app_activated":
      return "you switch apps";
    case "window_focused":
      return "you switch windows";
    case "navigation":
      return "you open a page";
    case "record_opened":
      return "you open a record";
    case "record_updated":
      return "you update a record";
    case "table_read":
      return "you read a table";
    case "table_exported":
      return "you export a report";
    case "copy_semantic":
      return withSemantic("you copy data");
    case "paste_semantic":
      return withSemantic("you paste data");
    case "idle_started":
    case "idle_ended":
      return "a pause";
    default:
      return `you ${eventType.replace(/_/g, " ")}`;
  }
}

/** Automation chain for one token — every capability the recipe could use for
 * this step, in catalog order (propose-first where a write exists). */
function automationFor(token: string, eventType: string): StepAutomation {
  const ids = capabilitiesForToken(token);
  if (ids.length > 0) {
    const steps: AutomationStep[] = [];
    for (const id of ids) {
      const capability = getCapability(id);
      if (!capability) continue;
      const mode: AutomationStep["mode"] = capability.supported_modes.includes("write")
        ? "write"
        : capability.supported_modes.includes("propose_write")
          ? "propose_write"
          : "read";
      steps.push({
        capability_id: id,
        action: capability.display_name,
        mode,
        // The compiler marks every write step approval-required and the policy
        // engine independently requires approval for material writes — pinned
        // by writes_need_approval_is_guaranteed in agent-runtime.
        needs_approval: mode === "write",
        reversible: capability.reversible,
      });
    }
    if (steps.length > 0) return { kind: "automated", steps };
  }
  if (CONTEXT_EVENT_TYPES.includes(eventType)) {
    return { kind: "context", note: "context only — a helper has nothing to do here" };
  }
  return { kind: "manual", note: "stays with you — no safe way for a helper to do this" };
}

/**
 * Explains a canonical sequence step by step. Consecutive identical tokens
 * collapse into one step with a repeat count; order is otherwise preserved
 * exactly (unlike the evidence list, which dedupes globally and loses it).
 */
export function explainWorkflowSteps(sequence: string[]): WorkflowExplanation {
  const steps: ObservedStepExplanation[] = [];
  let previous: string | null = null;

  for (const token of sequence) {
    if (token === previous) {
      steps[steps.length - 1]!.repeats += 1;
      continue;
    }
    previous = token;
    const parts = token.split(":");
    const app = parts[1] ?? "other";
    const eventType = parts[2] ?? "";
    const role = parts[3] ?? "-";
    const semantic = parts[4] ?? "-";
    steps.push({
      order: steps.length + 1,
      observed: observedPhrase(eventType, role, semantic),
      app: APP_LABELS[app] ?? app,
      repeats: 1,
      automation: automationFor(token, eventType),
    });
  }

  const work = steps.filter((s) => s.automation.kind !== "context");
  const automated = work.filter((s) => s.automation.kind === "automated");
  const hasWrites = automated.some(
    (s) => s.automation.kind === "automated" && s.automation.steps.some((c) => c.mode === "write"),
  );

  return {
    steps,
    automated_count: automated.length,
    work_step_count: work.length,
    read_only: automated.length > 0 && !hasWrites,
    has_writes: hasWrites,
  };
}
