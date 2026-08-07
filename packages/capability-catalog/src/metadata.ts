import type { CapabilityRiskLevel } from "@maman/contracts";

/**
 * Capability metadata — the v1 catalog (spec §15). Adapters implement these
 * at M7 (demo) and M8 (real); this metadata layer is what the pattern engine
 * (feasibility), compiler, and policy engine reason over.
 *
 * NOTE deliberate absences: no gmail.send, no deletion, no payment — those
 * capabilities do not exist in v1 at all.
 */

export type CapabilityMode = "read" | "propose_write" | "write";

export type CapabilityMetadata = {
  id: string;
  version: number;
  display_name: string;
  connector: "salesforce" | "google_sheets" | "gmail" | "google_calendar" | "browser" | "local";
  supported_modes: CapabilityMode[];
  risk_level: CapabilityRiskLevel;
  required_scopes: string[];
  is_idempotent: boolean;
  retry_class: "safe" | "unsafe" | "conditional";
  /** Write capabilities must be reversible or explicitly marked otherwise. */
  reversible: boolean;
};

const cap = (
  id: string,
  connector: CapabilityMetadata["connector"],
  display_name: string,
  supported_modes: CapabilityMode[],
  risk_level: CapabilityRiskLevel,
  opts: Partial<
    Pick<CapabilityMetadata, "required_scopes" | "is_idempotent" | "retry_class" | "reversible">
  > = {},
): CapabilityMetadata => ({
  id,
  version: 1,
  display_name,
  connector,
  supported_modes,
  risk_level,
  required_scopes: opts.required_scopes ?? [],
  is_idempotent: opts.is_idempotent ?? true,
  retry_class: opts.retry_class ?? "safe",
  reversible: opts.reversible ?? true,
});

export const CAPABILITIES: CapabilityMetadata[] = [
  // Salesforce
  cap("salesforce.query_records", "salesforce", "Query Salesforce records", ["read"], "low", {
    required_scopes: ["api"],
  }),
  cap("salesforce.get_record", "salesforce", "Get a Salesforce record", ["read"], "low", {
    required_scopes: ["api"],
  }),
  cap("salesforce.compare_records", "salesforce", "Compare Salesforce records", ["read"], "low"),
  cap(
    "salesforce.propose_upsert",
    "salesforce",
    "Propose Salesforce upserts",
    ["propose_write"],
    "low",
  ),
  cap(
    "salesforce.upsert_records",
    "salesforce",
    "Upsert Salesforce records",
    ["propose_write", "write"],
    "medium",
    { required_scopes: ["api"], is_idempotent: true, retry_class: "conditional" },
  ),
  cap(
    "salesforce.propose_field_updates",
    "salesforce",
    "Propose Salesforce field updates",
    ["propose_write"],
    "low",
  ),
  cap(
    "salesforce.update_fields",
    "salesforce",
    "Update Salesforce fields",
    ["propose_write", "write"],
    "medium",
    { required_scopes: ["api"], retry_class: "conditional" },
  ),
  // Google Sheets
  cap("google_sheets.read_range", "google_sheets", "Read a Sheets range", ["read"], "low", {
    required_scopes: ["spreadsheets.readonly"],
  }),
  cap("google_sheets.compare_rows", "google_sheets", "Compare Sheets rows", ["read"], "low"),
  cap(
    "google_sheets.propose_write_range",
    "google_sheets",
    "Propose a Sheets range write",
    ["propose_write"],
    "low",
  ),
  cap(
    "google_sheets.write_range",
    "google_sheets",
    "Write a Sheets range",
    ["propose_write", "write"],
    "medium",
    { required_scopes: ["spreadsheets"], retry_class: "conditional" },
  ),
  cap(
    "google_sheets.append_rows",
    "google_sheets",
    "Append rows to a Sheet",
    ["propose_write", "write"],
    "medium",
    { required_scopes: ["spreadsheets"], retry_class: "conditional", is_idempotent: false },
  ),
  // Gmail (metadata + drafts ONLY — no send capability exists)
  cap("gmail.search_metadata", "gmail", "Search Gmail metadata", ["read"], "low", {
    required_scopes: ["gmail.metadata"],
  }),
  cap("gmail.get_thread_metadata", "gmail", "Get Gmail thread metadata", ["read"], "low", {
    required_scopes: ["gmail.metadata"],
  }),
  cap("gmail.create_draft", "gmail", "Create a Gmail draft", ["propose_write", "write"], "medium", {
    required_scopes: ["gmail.compose"],
    is_idempotent: false,
    retry_class: "conditional",
  }),
  cap("gmail.update_draft", "gmail", "Update a Gmail draft", ["propose_write", "write"], "medium", {
    required_scopes: ["gmail.compose"],
    retry_class: "conditional",
  }),
  // Calendar (drafts only)
  cap("google_calendar.list_events", "google_calendar", "List calendar events", ["read"], "low", {
    required_scopes: ["calendar.readonly"],
  }),
  cap(
    "google_calendar.find_open_slots",
    "google_calendar",
    "Find open calendar slots",
    ["read"],
    "low",
  ),
  cap(
    "google_calendar.create_event_draft",
    "google_calendar",
    "Draft a calendar event",
    ["propose_write", "write"],
    "medium",
    { is_idempotent: false, retry_class: "conditional" },
  ),
  // Browser
  cap("browser.extract_table", "browser", "Extract a table from the page", ["read"], "low"),
  cap("browser.extract_structured_fields", "browser", "Extract structured fields", ["read"], "low"),
  cap("browser.propose_form_fill", "browser", "Propose a form fill", ["propose_write"], "low"),
  cap(
    "browser.supervised_form_fill",
    "browser",
    "Supervised form fill",
    ["propose_write", "write"],
    "high",
    { is_idempotent: false, retry_class: "unsafe", reversible: false },
  ),
  // Local
  cap("local.parse_csv", "local", "Parse a CSV", ["read"], "low"),
  cap("local.match_records", "local", "Match records", ["read"], "low"),
  cap("local.deduplicate_records", "local", "Deduplicate records", ["read"], "low"),
  cap("local.transform_columns", "local", "Transform columns", ["read"], "low"),
  cap("local.generate_csv", "local", "Generate a CSV", ["read"], "low"),
  cap("local.generate_summary", "local", "Generate a summary", ["read"], "low"),
];

const byId = new Map(CAPABILITIES.map((c) => [c.id, c]));

export function getCapability(id: string): CapabilityMetadata | undefined {
  return byId.get(id);
}

export function capabilityExists(id: string): boolean {
  return byId.has(id);
}

/**
 * Roles that CANNOT hold a user-entered value. A `value_committed` on one of
 * these is the page updating itself while the user works — the AX observer
 * reports the value change either way, but no form was filled and no helper
 * should claim it would fill one. Covers both role vocabularies: AX-prefixed
 * (macOS observer) and lowercase ARIA-style (Chrome relay).
 */
export const NON_VALUE_HOLDING_ROLES: ReadonlySet<string> = new Set([
  // macOS AX observer
  "AXStaticText",
  "AXImage",
  "AXGroup",
  "AXLink",
  "AXButton",
  "AXMenuItem",
  "AXList",
  "AXTable",
  "AXRow",
  "AXColumn",
  "AXWebArea",
  "AXWindow",
  "AXHeading",
  // Chrome relay (ARIA-style)
  "row",
  "grid",
  "table",
  "button",
  "link",
]);

/**
 * Roles a user genuinely edits. Exported so UI copy (pattern-engine explain)
 * phrases agency from the same source of truth this mapping scores with.
 */
export const EDITABLE_VALUE_ROLES: ReadonlySet<string> = new Set([
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

/**
 * Maps a canonical pattern token to candidate capability ids (used by
 * feasibility scoring and the deterministic compiler recipe).
 * Token shape: source:app_category:event_type:role:semantic:object
 */
export function capabilitiesForToken(token: string): string[] {
  const [, appCategory, eventType, targetRole] = token.split(":");
  // ROLE-AWARE EXCEPTION: a browser value change on a role that cannot hold
  // user input is the page updating itself, not the user filling a form. The
  // honest automation for that step is reading the updated content — claiming
  // a form fill would score (and later compile) a write the workflow never
  // contained. Seen live: an AXStaticText step in the first real device
  // pattern rendered as "a block of text updates → Helper: propose a form
  // fill". Unknown/absent roles keep the write mapping (conservative: we
  // cannot rule out an edit, and the write chain is propose-first and
  // approval-gated either way).
  if (
    appCategory === "browser" &&
    eventType === "value_committed" &&
    targetRole !== undefined &&
    NON_VALUE_HOLDING_ROLES.has(targetRole)
  ) {
    return ["browser.extract_structured_fields"];
  }
  const key = `${appCategory}/${eventType}`;
  const table: Record<string, string[]> = {
    "crm/record_opened": ["salesforce.get_record"],
    "crm/record_updated": ["salesforce.propose_field_updates", "salesforce.update_fields"],
    // Live observation records CRM field edits as value_committed (the curated
    // fixtures use record_updated) — the same business action, same capabilities.
    "crm/value_committed": ["salesforce.propose_field_updates", "salesforce.update_fields"],
    "crm/table_read": ["salesforce.query_records"],
    "crm/element_activated": ["salesforce.query_records"],
    "crm/element_focused": ["salesforce.get_record"],
    "crm/copy_semantic": ["salesforce.get_record"],
    "crm/navigation": ["salesforce.query_records"],
    "spreadsheet/table_read": ["google_sheets.read_range", "local.parse_csv"],
    "spreadsheet/value_committed": ["local.transform_columns"],
    "spreadsheet/paste_semantic": ["google_sheets.propose_write_range"],
    "spreadsheet/table_exported": ["local.generate_csv"],
    "spreadsheet/navigation": ["google_sheets.read_range"],
    // Same omission as the `browser/` pair below, found by the vocabulary test
    // rather than by looking: focusing a cell is reading a range, and without
    // this a spreadsheet workflow observed live scored feasibility 0 too.
    "spreadsheet/element_focused": ["google_sheets.read_range"],
    "email/navigation": ["gmail.search_metadata"],
    "email/record_opened": ["gmail.get_thread_metadata"],
    "calendar/navigation": ["google_calendar.list_events"],
    "browser/table_read": ["browser.extract_table"],
    "browser/record_opened": ["browser.extract_structured_fields"],
    // THE EVENT TYPES THE LIVE macOS OBSERVER ACTUALLY EMITS.
    //
    // Without these, nothing observed on a real machine was ever automatable.
    // The AX observer classifies a browser as `browser` (only the Chrome relay
    // can narrow it to `crm`), and emits `element_focused` and `value_committed`
    // — neither of which had a `browser/` entry. So every real token resolved to
    // zero capabilities, `feasibilityScore` returned 0 for every candidate, and
    // `min_feasibility` (0.6, a SAFETY bar the user cannot tune) rejected all of
    // them. 10k observed events produced 438 episodes, 58 candidates and ZERO
    // eligible ones, with no surface anywhere saying why.
    //
    // These two are honest rather than convenient: reading a field on a page and
    // filling one in are exactly what `packages/browser-actuator` now does, so
    // the feasibility claim is backed by a real execution lane. Propose-first
    // ordering matches `crm/value_committed` above, and matters — feasibility
    // inspects candidates[0], so the reversible propose step is what it sees.
    "browser/element_focused": ["browser.extract_structured_fields"],
    "browser/value_committed": ["browser.propose_form_fill", "browser.supervised_form_fill"],
  };
  return table[key] ?? [];
}

/**
 * Event types that are CONTEXT, not work: switching app, focusing a window.
 *
 * Deliberately absent from the table above. There is no capability for "the user
 * changed app", and inventing one to raise a feasibility score would be scoring
 * a claim we cannot honour. They stay unmapped and dilute feasibility slightly,
 * which is the correct signal: an episode that is mostly app-switching is mostly
 * not automatable.
 */
export const CONTEXT_EVENT_TYPES: readonly string[] = [
  "app_activated",
  "window_focused",
  "idle_started",
  "idle_ended",
  "boundary_redacted",
];
