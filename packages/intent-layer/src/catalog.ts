import type { AutomationIntent } from "./types.js";

/**
 * The intents Maman can actually carry out.
 *
 * Deliberately SHORT. Every entry here is a promise that the capabilities named
 * exist, that the slots are genuinely resolvable, and that success can be
 * proven — so an intent is added when those are true, not when the shape seems
 * plausible. A catalog padded with aspirational intents would put "I can do
 * this" in front of the user for work that has no working execution path, which
 * is the failure mode this whole layer exists to end.
 *
 * What is deliberately absent is as informative as what is here: nothing
 * reads a table, because an unbounded table read is an unbounded page read;
 * nothing sends anything; nothing deletes.
 */

/**
 * Set one field on the record already open, then prove it took.
 *
 * This is the shape behind the commonest observed pattern — a person opens a
 * record and retypes a field — and it is fully executable today: the field is
 * discovered by reading the live page, and the only thing that must be supplied
 * is the value, which is the one part no amount of looking can reveal.
 */
export const UPDATE_FIELD_ON_OPEN_RECORD: AutomationIntent = {
  intent_id: "update_field_on_open_record",
  version: 1,
  verb: "Set",
  purpose: "Update a single field on the record you already have open.",
  slots: [
    {
      name: "site",
      kind: "record_locator",
      description: "The site this happens on",
      required: true,
      resolution: "discoverable",
    },
    {
      name: "field",
      kind: "field",
      description: "The field to change",
      required: true,
      resolution: "discoverable",
      accepts_roles: ["textbox", "combobox"],
    },
    {
      name: "new_value",
      kind: "value",
      description: "What the field should say",
      required: true,
      // No page reveals what a person intends to type.
      resolution: "supplied",
    },
  ],
  requires_capabilities: [
    "browser.extract_structured_fields",
    "browser.propose_form_fill",
    "browser.supervised_form_fill",
  ],
  success: "readback",
};

/**
 * Read named fields off the record already open, and change nothing.
 *
 * Read-only, so it needs no supplied value and no approval — the safest useful
 * automation, and a good first thing for a user to watch the agent do.
 */
export const READ_FIELDS_ON_OPEN_RECORD: AutomationIntent = {
  intent_id: "read_fields_on_open_record",
  version: 1,
  verb: "Read",
  purpose: "Read fields off the record you have open, without changing anything.",
  slots: [
    {
      name: "site",
      kind: "record_locator",
      description: "The site this happens on",
      required: true,
      resolution: "discoverable",
    },
    {
      name: "field",
      kind: "field",
      description: "The field to read",
      required: true,
      resolution: "discoverable",
      accepts_roles: ["textbox", "combobox", "cell"],
    },
  ],
  requires_capabilities: ["browser.extract_structured_fields"],
  success: "none",
};

export const SHIPPED_INTENTS: readonly AutomationIntent[] = [
  UPDATE_FIELD_ON_OPEN_RECORD,
  READ_FIELDS_ON_OPEN_RECORD,
];

export function getIntent(intentId: string): AutomationIntent | undefined {
  return SHIPPED_INTENTS.find((i) => i.intent_id === intentId);
}

/**
 * The intents an observed workflow could plausibly BE, from its shape alone.
 *
 * This is a narrowing, not a decision: it says which automations are worth
 * resolving against the surface, and resolution decides whether any of them
 * actually fits. A pattern that only reads cannot be an update intent, so
 * offering one would be proposing work the user was never seen doing.
 */
export function candidateIntents(tokens: readonly string[]): AutomationIntent[] {
  const parts = tokens.map((t) => t.split(":"));
  const inBrowser = parts.some((p) => p[1] === "browser" || p[1] === "crm");
  if (!inBrowser) return [];

  const WRITE_EVENTS = new Set(["value_committed", "record_updated", "paste_semantic"]);
  const writes = parts.some((p) => WRITE_EVENTS.has(p[2] ?? ""));

  return writes
    ? [UPDATE_FIELD_ON_OPEN_RECORD, READ_FIELDS_ON_OPEN_RECORD]
    : [READ_FIELDS_ON_OPEN_RECORD];
}

/**
 * Which required capabilities a runtime is missing for this intent.
 *
 * Checked BEFORE an intent is offered, so the user is never shown an automation
 * this device cannot perform — the mistake that produced compiled agents with
 * no adapter behind them.
 */
export function missingCapabilities(
  intent: AutomationIntent,
  available: ReadonlySet<string>,
): string[] {
  return intent.requires_capabilities.filter((c) => !available.has(c));
}
