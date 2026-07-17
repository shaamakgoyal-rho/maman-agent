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
 * Maps a canonical pattern token to candidate capability ids (used by
 * feasibility scoring and the deterministic compiler recipe).
 * Token shape: source:app_category:event_type:role:semantic:object
 */
export function capabilitiesForToken(token: string): string[] {
  const [, appCategory, eventType] = token.split(":");
  const key = `${appCategory}/${eventType}`;
  const table: Record<string, string[]> = {
    "crm/record_opened": ["salesforce.get_record"],
    "crm/record_updated": ["salesforce.propose_field_updates", "salesforce.update_fields"],
    "crm/table_read": ["salesforce.query_records"],
    "crm/element_activated": ["salesforce.query_records"],
    "crm/copy_semantic": ["salesforce.get_record"],
    "crm/navigation": ["salesforce.query_records"],
    "spreadsheet/table_read": ["google_sheets.read_range", "local.parse_csv"],
    "spreadsheet/value_committed": ["local.transform_columns"],
    "spreadsheet/paste_semantic": ["google_sheets.propose_write_range"],
    "spreadsheet/table_exported": ["local.generate_csv"],
    "spreadsheet/navigation": ["google_sheets.read_range"],
    "email/navigation": ["gmail.search_metadata"],
    "email/record_opened": ["gmail.get_thread_metadata"],
    "calendar/navigation": ["google_calendar.list_events"],
    "browser/table_read": ["browser.extract_table"],
    "browser/record_opened": ["browser.extract_structured_fields"],
  };
  return table[key] ?? [];
}
