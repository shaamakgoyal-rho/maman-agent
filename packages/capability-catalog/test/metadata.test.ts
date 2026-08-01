import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  capabilitiesForToken,
  capabilityExists,
  getCapability,
} from "../src/index.js";

describe("capability catalog (v1)", () => {
  it("contains the required v1 capability set", () => {
    for (const id of [
      "salesforce.query_records",
      "salesforce.get_record",
      "salesforce.compare_records",
      "salesforce.propose_upsert",
      "salesforce.upsert_records",
      "salesforce.propose_field_updates",
      "salesforce.update_fields",
      "google_sheets.read_range",
      "google_sheets.compare_rows",
      "google_sheets.propose_write_range",
      "google_sheets.write_range",
      "google_sheets.append_rows",
      "gmail.search_metadata",
      "gmail.get_thread_metadata",
      "gmail.create_draft",
      "gmail.update_draft",
      "google_calendar.list_events",
      "google_calendar.find_open_slots",
      "google_calendar.create_event_draft",
      "browser.extract_table",
      "browser.extract_structured_fields",
      "browser.propose_form_fill",
      "browser.supervised_form_fill",
      "local.parse_csv",
      "local.match_records",
      "local.deduplicate_records",
      "local.transform_columns",
      "local.generate_csv",
      "local.generate_summary",
    ]) {
      expect(capabilityExists(id), `${id} must exist`).toBe(true);
    }
  });

  it("NEVER contains send, delete, or payment capabilities", () => {
    const ids = CAPABILITIES.map((c) => c.id).join(" ");
    expect(ids).not.toMatch(/send|delete|payment|purchase|transfer/);
  });

  it("every write-capable capability also supports propose_write", () => {
    for (const capability of CAPABILITIES) {
      if (capability.supported_modes.includes("write")) {
        expect(
          capability.supported_modes.includes("propose_write"),
          `${capability.id} must support propose_write`,
        ).toBe(true);
      }
    }
  });

  it("supervised form fill is high risk and irreversible", () => {
    const formFill = getCapability("browser.supervised_form_fill")!;
    expect(formFill.risk_level).toBe("high");
    expect(formFill.reversible).toBe(false);
    expect(formFill.retry_class).toBe("unsafe");
  });

  it("maps canonical tokens to capabilities", () => {
    expect(capabilitiesForToken("chrome:crm:table_read:table:x:account")).toContain(
      "salesforce.query_records",
    );
    expect(capabilitiesForToken("chrome:spreadsheet:table_read:grid:x:account")).toContain(
      "google_sheets.read_range",
    );
    expect(capabilitiesForToken("chrome:other:unknown_event:-:-:-")).toEqual([]);
  });

  it("maps the live CRM edit vocabulary (value_committed / element_focused)", () => {
    // Live observation records field edits as value_committed — same business
    // action (and capabilities) as the fixtures' record_updated.
    expect(
      capabilitiesForToken("browser_extension:crm:value_committed:input:account_name:account"),
    ).toEqual(["salesforce.propose_field_updates", "salesforce.update_fields"]);
    expect(capabilitiesForToken("macos_ax:crm:element_focused:AXTextField:-:-")).toEqual([
      "salesforce.get_record",
    ]);
  });
});
