import { describe, expect, it } from "vitest";
import { buildSemanticEvent, classifyField, contextFromUrl } from "../src/lib/semantic.js";

describe("classifyField (source-side redaction)", () => {
  it("denies password and hidden inputs", () => {
    expect(classifyField({ tag: "INPUT", type: "password" })).toBe("deny");
    expect(classifyField({ tag: "INPUT", type: "hidden" })).toBe("deny");
  });

  it("denies sensitive autocomplete values", () => {
    for (const autocomplete of [
      "current-password",
      "new-password",
      "one-time-code",
      "cc-number",
      "cc-csc",
    ]) {
      expect(classifyField({ tag: "INPUT", type: "text", autocomplete })).toBe("deny");
    }
  });

  it("denies fields whose names look sensitive", () => {
    for (const name of ["password", "api_key", "ssn", "card_number", "bank_routing", "otp_code"]) {
      expect(classifyField({ tag: "INPUT", type: "text", name })).toBe("deny");
    }
    expect(classifyField({ tag: "INPUT", type: "text", ariaLabel: "Social-Security Number" })).toBe(
      "deny",
    );
  });

  it("treats contenteditable, textareas, and message fields as shape-only", () => {
    expect(classifyField({ tag: "DIV", contentEditable: true })).toBe("shape_only");
    expect(classifyField({ tag: "TEXTAREA" })).toBe("shape_only");
    expect(classifyField({ tag: "INPUT", type: "text", name: "message_body" })).toBe("shape_only");
    expect(classifyField({ tag: "INPUT", type: "text", id: "compose-area" })).toBe("shape_only");
  });

  it("observes ordinary business fields", () => {
    expect(classifyField({ tag: "INPUT", type: "text", name: "company_domain" })).toBe("observe");
    expect(classifyField({ tag: "SELECT", name: "account_segment" })).toBe("observe");
  });
});

describe("contextFromUrl (deterministic URL-derived context)", () => {
  it("maps Salesforce Lightning object-home routes (/lightning/o/)", () => {
    expect(
      contextFromUrl("https://acme.lightning.force.com/lightning/o/Account/list?filterName=Recent"),
    ).toEqual({ object_type: "account", page_type: "object_home" });
    expect(contextFromUrl("https://acme.lightning.force.com/lightning/o/Opportunity/home")).toEqual(
      { object_type: "opportunity", page_type: "object_home" },
    );
  });

  it("maps Salesforce Lightning record routes (/lightning/r/) without leaking the id", () => {
    const ctx = contextFromUrl(
      "https://acme.lightning.force.com/lightning/r/Account/0015e00000AbCdEfGH/view",
    );
    expect(ctx).toEqual({ object_type: "account", page_type: "record" });
    expect(JSON.stringify(ctx)).not.toContain("0015e00000AbCdEfGH");
  });

  it("supports custom-object API names on Lightning routes", () => {
    expect(
      contextFromUrl("https://acme.lightning.force.com/lightning/r/Invoice__c/a015e000001/view"),
    ).toEqual({ object_type: "invoice__c", page_type: "record" });
  });

  it("rejects bare-record-id Lightning routes and other lightning paths", () => {
    // /lightning/r/{id}/view (no object segment): ids start with a digit prefix.
    expect(
      contextFromUrl("https://acme.lightning.force.com/lightning/r/0015e00000AbCdEfGH/view"),
    ).toEqual({});
    // Non-o/r lightning routes never fall through to the generic rule.
    expect(contextFromUrl("https://acme.lightning.force.com/lightning/page/home")).toEqual({});
  });

  it("maps Google Sheets to page_type spreadsheet without reading the doc id", () => {
    const ctx = contextFromUrl(
      "https://docs.google.com/spreadsheets/d/1AbC-secret-doc-id/edit#gid=0",
    );
    expect(ctx).toEqual({ page_type: "spreadsheet" });
    expect(JSON.stringify(ctx)).not.toContain("1AbC-secret-doc-id");
  });

  it("uses a purely alphabetic first segment as naive-singular object_type", () => {
    expect(contextFromUrl("https://app.example.com/contacts/12345")).toEqual({
      object_type: "contact",
    });
    expect(contextFromUrl("https://app.example.com/Deals?stage=won")).toEqual({
      object_type: "deal",
    });
  });

  it("rejects numeric, slug, short, and long first segments", () => {
    expect(contextFromUrl("https://app.example.com/12345/edit")).toEqual({});
    expect(contextFromUrl("https://app.example.com/order-12345")).toEqual({});
    expect(contextFromUrl("https://app.example.com/jane.doe@example.com")).toEqual({});
    expect(contextFromUrl("https://app.example.com/ab")).toEqual({});
    expect(contextFromUrl(`https://app.example.com/${"a".repeat(33)}`)).toEqual({});
    expect(contextFromUrl("https://app.example.com/")).toEqual({});
  });

  it("never derives anything from query strings or fragments", () => {
    expect(contextFromUrl("https://app.example.com/?object=accounts&ssn=123")).toEqual({});
    expect(contextFromUrl("https://app.example.com/#/accounts/42")).toEqual({});
  });

  it("returns empty context for unparseable urls", () => {
    expect(contextFromUrl("not a url")).toEqual({});
  });
});

describe("buildSemanticEvent", () => {
  it("emits nothing for denied fields", async () => {
    expect(
      await buildSemanticEvent({
        kind: "commit",
        field: { tag: "INPUT", type: "password" },
        pageUrl: "https://app.example.com/login",
      }),
    ).toBeNull();
  });

  it("shape-only fields lose their semantic type but keep the interaction", async () => {
    const shape = await buildSemanticEvent({
      kind: "commit",
      field: { tag: "TEXTAREA", name: "message_body" },
      pageUrl: "https://app.slack.com/client",
    });
    expect(shape?.event_type).toBe("value_committed");
    expect(shape?.target.semantic_type).toBeUndefined();
    expect(JSON.stringify(shape)).not.toContain("message_body");
  });

  it("business fields carry semantic type and hashed stable id, never values", async () => {
    const shape = await buildSemanticEvent({
      kind: "commit",
      field: { tag: "INPUT", type: "text", name: "company_domain", id: "dom-1" },
      pageUrl: "https://docs.google.com/spreadsheets/d/abc",
    });
    expect(shape?.event_type).toBe("value_committed");
    expect(shape?.target.semantic_type).toBe("company_domain");
    expect(shape?.target.stable_id_hash).toMatch(/^[0-9a-f]{32}$/);
    expect(shape?.domain).toBe("docs.google.com");
  });

  it("every event kind carries the URL-derived context when derivable", async () => {
    const pageUrl = "https://acme.lightning.force.com/lightning/r/Account/0015e00000AbCdEfGH/view";
    const expected = { object_type: "account", page_type: "record" };

    const nav = await buildSemanticEvent({ kind: "navigation", pageUrl });
    expect(nav?.context).toEqual(expected);

    const click = await buildSemanticEvent({ kind: "click", targetRole: "button", pageUrl });
    expect(click?.context).toEqual(expected);

    const commit = await buildSemanticEvent({
      kind: "commit",
      field: { tag: "INPUT", type: "text", name: "account_segment" },
      pageUrl,
    });
    expect(commit?.context).toEqual(expected);

    for (const kind of ["copy", "paste"] as const) {
      const shape = await buildSemanticEvent({ kind, pageUrl });
      expect(shape?.context).toEqual(expected);
    }
    // The record id from the URL never appears anywhere in any shape.
    expect(JSON.stringify([nav, click, commit])).not.toContain("0015e00000AbCdEfGH");
  });

  it("clicks, copies, and pastes are shapes with no content", async () => {
    for (const kind of ["click", "copy", "paste"] as const) {
      const shape = await buildSemanticEvent({
        kind,
        pageUrl: "https://acme.lightning.force.com/one",
        ...(kind === "click" ? { targetRole: "row" } : {}),
      });
      expect(shape).not.toBeNull();
      const json = JSON.stringify(shape);
      // No content-bearing keys: only shapes (event_type/target/context/domain).
      expect(json).not.toMatch(/"value"|"text"|clipboard|password|"body"/);
      expect(Object.keys(shape!).sort()).toEqual(["context", "domain", "event_type", "target"]);
    }
  });
});
