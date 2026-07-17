import { describe, expect, it } from "vitest";
import { buildSemanticEvent, classifyField } from "../src/lib/semantic.js";

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
