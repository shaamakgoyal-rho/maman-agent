import { describe, expect, it } from "vitest";
import { chainTitle, describeObserved, stepPhrase } from "../src/naming.js";

/**
 * Suggestion titles must say what the workflow IS.
 *
 * The old fallback read "Automate your record workflow across the browser" for
 * anything the three hardcoded recipes missed — which says nothing, and asserts
 * an object ("record") that is just the default when no object was observed.
 * These tests pin the replacement: every title is built from evidence, and when
 * there is no evidence the title admits it rather than inventing a noun.
 */

/** token = source:app:event_type:role:semantic_type:object_type */
const t = (app: string, event: string, semantic = "-", object = "-") =>
  `chrome:${app}:${event}:row:${semantic}:${object}`;

describe("titles name the work, not the fact that it repeats", () => {
  it("uses the pack ACTION when the classifier recognised one", () => {
    const title = describeObserved(
      [
        t("erp", "record_opened", "close_task", "close_task"),
        t("erp", "value_committed", "accrual", "accrual"),
      ],
      ["extract_field", "post_journal"],
    );
    // The business action, not "update fields".
    expect(title).toContain("Post journal");
    expect(title).toContain("accruals");
  });

  it("names the app data moves BETWEEN when two are involved", () => {
    const title = describeObserved(
      [t("crm", "table_read", "-", "account"), t("spreadsheet", "value_committed", "-", "account")],
      [],
    );
    expect(title).toBe("Update accounts in your spreadsheet from Salesforce");
  });

  it("describes a read-only workflow as a review, not an update", () => {
    const title = describeObserved(
      [
        t("crm", "record_opened", "renewal", "renewal"),
        t("crm", "table_read", "renewal", "renewal"),
      ],
      [],
    );
    expect(title).toBe("Open renewals in Salesforce");
    expect(title).not.toMatch(/update|change/i);
  });

  it("prefers the semantic type over the coarser object type", () => {
    const title = describeObserved([t("erp", "table_read", "invoice_match", "invoice")], []);
    expect(title).toContain("invoice matches");
  });

  it("pluralizes real nouns properly", () => {
    expect(describeObserved([t("erp", "table_read", "-", "purchase_order")], [])).toContain(
      "purchase orders",
    );
    // -y → -ies, and a trailing s/x/ch gets -es rather than a bare -s.
    expect(describeObserved([t("crm", "table_read", "-", "opportunity")], [])).toContain(
      "opportunities",
    );
    expect(describeObserved([t("erp", "table_read", "-", "tax")], [])).toContain("taxes");
  });

  it("falls back to the target ROLE before admitting defeat", () => {
    // No semantic or object noun — but the role is observed evidence, and
    // "Review table rows" tells the reader which habit this is where
    // "Repeated 3-step workflow" told them nothing.
    const title = describeObserved(
      [
        t("browser", "element_focused"),
        t("browser", "window_focused"),
        t("browser", "element_focused"),
      ],
      [],
    );
    expect(title).toBe("Review table rows in the browser");
    // The original failure stays fixed: no invented noun, no "Automate your".
    expect(title).not.toContain("record");
    expect(title).not.toMatch(/^Automate your/);
  });

  it("names the LIVE device pattern by its real write target", () => {
    // The first real device's eligible pattern (019fc4d0, replay 21/21). Its
    // card was headlined "Repeated 3-step workflow in the browser"; the write
    // target's role names it. The AXStaticText step is the page updating
    // itself and must not become the headline act.
    const title = describeObserved(
      [
        "macos_ax:browser:element_focused:AXGroup:-:-",
        "macos_ax:browser:value_committed:AXStaticText:-:-",
        "macos_ax:browser:value_committed:AXTextField:-:-",
      ],
      [],
    );
    expect(title).toBe("Update text fields in the browser");
  });

  it("pluralizes a role phrase's head noun, not its tail", () => {
    const title = describeObserved(["macos_ax:browser:element_focused:AXGroup:-:-"], []);
    expect(title).toBe("Review sections of the page in the browser");
    expect(title).not.toContain("pages");
  });

  it("ADMITS IT when there is not even a role", () => {
    const title = describeObserved(
      ["chrome:browser:element_focused:-:-:-", "chrome:browser:window_focused:-:-:-"],
      [],
    );
    expect(title).toBe("Repeated 2-step workflow in the browser");
    expect(title).not.toContain("record");
  });

  it("never claims an app or object that was not in the evidence", () => {
    const title = describeObserved([t("email", "paste_semantic", "-", "message")], []);
    expect(title).toBe("Paste messages in Gmail");
    expect(title).not.toContain("Salesforce");
    expect(title).not.toContain("spreadsheet");
  });

  it("is deterministic and never empty", () => {
    const seq = [
      t("crm", "record_opened", "renewal"),
      t("email", "value_committed", "renewal_email"),
    ];
    expect(describeObserved(seq, [])).toBe(describeObserved(seq, []));
    expect(describeObserved([], []).length).toBeGreaterThan(0);
  });
});

describe("the summary says what the workflow consists of", () => {
  it("leads with the steps, then the evidence", () => {
    const phrase = stepPhrase([
      t("crm", "record_opened", "-", "account"),
      t("crm", "table_read", "-", "account"),
      t("spreadsheet", "value_committed", "-", "account"),
    ]);
    expect(phrase).toBe(
      "open accounts in Salesforce, read accounts, then update accounts in your spreadsheet",
    );
  });

  it("names an app only when it CHANGES, so a switch stands out", () => {
    const phrase = stepPhrase([
      t("crm", "record_opened", "-", "account"),
      t("crm", "table_read", "-", "account"),
    ])!;
    // "in Salesforce" appears once, not once per step.
    expect(phrase.match(/in Salesforce/g)?.length).toBe(1);
  });

  it("dedupes repeated step shapes and caps the list", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      t(
        "crm",
        ["record_opened", "table_read", "value_committed", "navigation", "element_focused"][i % 5]!,
      ),
    );
    const phrase = stepPhrase(many)!;
    expect(phrase.split(",").length).toBeLessThanOrEqual(4);
  });

  it("returns null rather than an empty phrase when there is nothing to say", () => {
    expect(stepPhrase([])).toBeNull();
  });

  it("describes the LIVE device pattern role-aware, agency-honest", () => {
    const phrase = stepPhrase([
      "macos_ax:browser:element_focused:AXGroup:-:-",
      "macos_ax:browser:value_committed:AXStaticText:-:-",
      "macos_ax:browser:value_committed:AXTextField:-:-",
    ]);
    // "a block of text updates" — the page did that, not the user. The two
    // value_committed steps have different roles and must NOT dedupe into one.
    expect(phrase).toBe(
      "focus a section of the page in the browser, a block of text updates, then change a text field",
    );
  });
});

describe("multi-app workflows are named as the chain of hops", () => {
  it("names each hop by its app and its most consequential act", () => {
    const title = chainTitle([
      t("crm", "record_opened", "-", "contact"),
      t("crm", "value_committed", "phone", "contact"),
      t("research", "navigation"),
      t("research", "value_committed", "message"),
      t("spreadsheet", "paste_semantic", "-", "row"),
      t("messaging", "value_committed", "message"),
    ]);
    expect(title).toBe("Salesforce update → LinkedIn message → spreadsheet entry → Slack message");
  });

  it("labels a read-only hop by what the reading was for", () => {
    const title = chainTitle([
      t("email", "record_opened", "-", "thread"),
      t("crm", "value_committed", "-", "opportunity"),
    ]);
    expect(title).toBe("Gmail lookup → Salesforce update");
  });

  it("is null for a single-app workflow — a chain of one is not a chain", () => {
    expect(chainTitle([t("crm", "record_opened"), t("crm", "value_committed")])).toBeNull();
  });

  it("drops pure app switches and collapses consecutive same-app steps", () => {
    const title = chainTitle([
      t("crm", "record_opened"),
      t("crm", "app_activated"),
      t("spreadsheet", "window_focused"),
      t("spreadsheet", "value_committed"),
      t("spreadsheet", "value_committed"),
    ]);
    expect(title).toBe("Salesforce lookup → spreadsheet entry");
  });

  it("caps a long copy-paste loop instead of naming every lap", () => {
    const laps = [
      t("crm", "copy_semantic"),
      t("spreadsheet", "paste_semantic"),
      t("crm", "record_opened"),
      t("email", "value_committed"),
      t("messaging", "value_committed"),
      t("calendar", "value_committed"),
    ];
    const title = chainTitle(laps)!;
    expect(title.split(" → ")).toHaveLength(4);
    expect(title.endsWith("Calendar event")).toBe(true);
  });
});
