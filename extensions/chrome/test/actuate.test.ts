// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  browserActionRequestSchema,
  browserActionResultSchema,
  type BrowserAction,
} from "@maman/contracts";
import {
  executeBrowserAction,
  sanitizeObserved,
  type ActuationContext,
} from "../src/lib/actuate.js";

const ORIGIN = "https://acme.my.salesforce.com";
const TOKEN = "a".repeat(48);
const NOW = new Date("2026-08-05T12:00:00.000Z");

function request(action: BrowserAction, over: Record<string, unknown> = {}) {
  return browserActionRequestSchema.parse({
    schema_version: 1,
    type: "browser_action_request",
    request_id: "018f0000-0000-7000-8000-000000000001",
    run_id: "018f0000-0000-7000-8000-000000000002",
    step_id: "step-1",
    action,
    authorization: TOKEN,
    allowed_origins: [ORIGIN],
    consequential: action.kind === "set_value" || action.kind === "click_control",
    issued_at: "2026-08-05T11:59:30.000Z",
    expires_at: "2026-08-05T12:01:00.000Z",
    ...over,
  });
}

function ctx(over: Partial<ActuationContext> = {}): ActuationContext {
  return {
    origin: ORIGIN,
    privateWindow: false,
    userPresent: true,
    paused: false,
    authorizationValid: true,
    ...over,
  };
}

function render(html: string): Document {
  document.body.innerHTML = html;
  return document;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("sanitizeObserved", () => {
  it("replaces secret-shaped page text outright", () => {
    expect(sanitizeObserved("AKIAIOSFODNN7EXAMPLE")).toBe("[redacted: secret-shaped value]");
    expect(sanitizeObserved(`sk-ant-${"x".repeat(30)}`)).toBe("[redacted: secret-shaped value]");
  });

  it("clips long page text to what the contract allows", () => {
    expect(sanitizeObserved("x".repeat(900))).toHaveLength(512);
  });

  it("passes ordinary values through and preserves absence", () => {
    expect(sanitizeObserved("2026-12-31")).toBe("2026-12-31");
    expect(sanitizeObserved(undefined)).toBeUndefined();
  });
});

describe("executeBrowserAction", () => {
  const target = { role: "textbox" as const, name: "Close date" };
  const FORM = `<label for="close">Close Date *</label>
    <input id="close" type="date" name="close_date" value="2026-09-30">`;

  it("rejects a request the contract does not accept", () => {
    const out = executeBrowserAction({ nonsense: true }, ctx(), render(FORM), NOW);
    expect(out).toEqual({ ok: false, error: "malformed_request" });
  });

  it("applies a write and reports both sides of the change", () => {
    const out = executeBrowserAction(
      request({ kind: "set_value", target, value: "2026-12-31" }),
      ctx(),
      render(FORM),
      NOW,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result).toMatchObject({
      outcome: "applied",
      observed: {
        resolved_name: "Close Date *",
        value_before: "2026-09-30",
        value_after: "2026-12-31",
        match_count: 1,
        origin: ORIGIN,
      },
    });
    expect(document.querySelector<HTMLInputElement>("#close")!.value).toBe("2026-12-31");
  });

  it("reports a read as observed, not applied", () => {
    const out = executeBrowserAction(
      request({ kind: "read_field", target }),
      ctx(),
      render(FORM),
      NOW,
    );
    expect(out.ok && out.result.outcome).toBe("observed");
  });

  it("refuses a secure field and reveals nothing about it", () => {
    const doc = render(`<input aria-label="Card number" autocomplete="cc-number" value="4111">`);
    const out = executeBrowserAction(
      request({
        kind: "set_value",
        target: { role: "textbox", name: "Card number" },
        value: "4242",
      }),
      ctx(),
      doc,
      NOW,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.outcome).toBe("refused");
    expect(out.result.refusal_reason).toBe("secure_field");
    // A refusal must not become a way to read the page.
    expect(out.result.observed).toMatchObject({ resolved_name: "" });
    expect(out.result.observed?.value_before).toBeUndefined();
    expect(out.result.observed?.value_after).toBeUndefined();
  });

  it("refuses an ambiguous target and says how many matched", () => {
    const doc = render(`
      <input aria-label="Amount" value="1">
      <input aria-label="Amount" value="2">
    `);
    const out = executeBrowserAction(
      request({ kind: "read_field", target: { role: "textbox", name: "Amount" } }),
      ctx(),
      doc,
      NOW,
    );
    expect(out.ok && out.result).toMatchObject({
      outcome: "refused",
      refusal_reason: "ambiguous_match",
      observed: { match_count: 2 },
    });
  });

  it("refuses when the service worker rejected the token", () => {
    const out = executeBrowserAction(
      request({ kind: "read_field", target }),
      ctx({ authorizationValid: false }),
      render(FORM),
      NOW,
    );
    expect(out.ok && out.result.refusal_reason).toBe("not_authorized");
  });

  it("redacts a secret-shaped value it read out of the page", () => {
    const doc = render(`<input aria-label="Notes" value="AKIAIOSFODNN7EXAMPLE">`);
    const out = executeBrowserAction(
      request({ kind: "read_field", target: { role: "textbox", name: "Notes" } }),
      ctx(),
      doc,
      NOW,
    );
    expect(out.ok && out.result.observed?.value_after).toBe("[redacted: secret-shaped value]");
  });

  it("clips page text that is longer than the contract permits, instead of failing", () => {
    const doc = render(`<textarea aria-label="Notes">${"x".repeat(900)}</textarea>`);
    const out = executeBrowserAction(
      request({ kind: "read_field", target: { role: "textbox", name: "Notes" } }),
      ctx(),
      doc,
      NOW,
    );
    expect(out.ok && out.result.observed?.value_after).toHaveLength(512);
  });

  it("does not claim to have navigated", () => {
    const out = executeBrowserAction(
      request({ kind: "navigate", url: `${ORIGIN}/x` }),
      ctx(),
      render(FORM),
      NOW,
    );
    expect(out.ok && out.result).toMatchObject({
      outcome: "failed",
      failure: "navigate is performed by the service worker",
    });
  });

  it("reports a page that throws as failed, not as applied", () => {
    const proto = globalThis.HTMLInputElement.prototype;
    const original = Object.getOwnPropertyDescriptor(proto, "value")!;
    Object.defineProperty(proto, "value", {
      ...original,
      set() {
        throw new Error("page script threw");
      },
    });
    try {
      const out = executeBrowserAction(
        request({ kind: "set_value", target, value: "2026-12-31" }),
        ctx(),
        render(FORM),
        NOW,
      );
      expect(out.ok && out.result).toMatchObject({
        outcome: "failed",
        failure: "the page threw while applying the action",
      });
    } finally {
      Object.defineProperty(proto, "value", original);
    }
  });

  it("produces results the contract accepts, for every branch", () => {
    // The result schema is strict and cross-field validated; a shape this code can
    // produce but the contract rejects would strand the run with no answer at all.
    const cases = [
      request({ kind: "set_value", target, value: "2026-12-31" }),
      request({ kind: "read_field", target }),
      request({ kind: "read_field", target: { role: "textbox", name: "Missing" } }),
      request({ kind: "navigate", url: `${ORIGIN}/x` }),
    ];
    for (const req of cases) {
      const out = executeBrowserAction(req, ctx(), render(FORM), NOW);
      expect(out.ok).toBe(true);
      if (!out.ok) continue;
      expect(browserActionResultSchema.safeParse(out.result).success, req.action.kind).toBe(true);
    }
  });
});

/**
 * The verb that lets an agent find its own target, through the extension lane.
 *
 * The own-window lane answers this from the in-page script; this one answers it
 * from the same `collectControls` walk every other action already does. Both
 * must return the same shape and keep the same line: the form, not the record.
 */
describe("list_controls through the extension lane", () => {
  const LIST: BrowserAction = { kind: "list_controls", roles: ["textbox"], limit: 40 };

  it("names the page's fields without reporting a single value", () => {
    const doc = render(`
      <label for="phone">Phone</label><input id="phone" type="text" value="555-0100" />
      <label for="email">Email</label><input id="email" type="text" value="a@b.test" />
    `);
    const out = executeBrowserAction(request(LIST), ctx(), doc, NOW);
    if (!out.ok) throw new Error("expected a result");
    // Real contract parse: a listing the schema would reject is not a listing.
    const result = browserActionResultSchema.parse(out.result);
    expect(result.outcome).toBe("observed");
    expect(result.observed?.controls?.map((c) => c.name).sort()).toEqual(["Email", "Phone"]);
    expect(JSON.stringify(result)).not.toContain("555-0100");
    expect(JSON.stringify(result)).not.toContain("a@b.test");
  });

  it("reports a password field as secure rather than omitting it", () => {
    const doc = render(`<label for="p">Password</label><input id="p" type="password" />`);
    const out = executeBrowserAction(request(LIST), ctx(), doc, NOW);
    if (!out.ok) throw new Error("expected a result");
    expect(out.result.observed?.controls).toEqual([
      { role: "textbox", name: "Password", secure: true, editable: true, duplicate_count: 1 },
    ]);
  });

  it("refuses on a foreign origin, like every other verb", () => {
    const doc = render(`<label for="phone">Phone</label><input id="phone" type="text" />`);
    const out = executeBrowserAction(
      request(LIST),
      ctx({ origin: "https://elsewhere.test" }),
      doc,
      NOW,
    );
    if (!out.ok) throw new Error("expected a result");
    expect(out.result.outcome).toBe("refused");
    expect(out.result.refusal_reason).toBe("origin_not_allowed");
    // A refusal must not leak the listing it would have produced.
    expect(out.result.observed?.controls).toBeUndefined();
  });

  it("says when the page had more fields than the caller would accept", () => {
    const doc = render(
      Array.from({ length: 6 }, (_, i) => `<input type="text" aria-label="Field ${i}" />`).join(""),
    );
    const out = executeBrowserAction(
      request({ kind: "list_controls", roles: ["textbox"], limit: 2 }),
      ctx(),
      doc,
      NOW,
    );
    if (!out.ok) throw new Error("expected a result");
    expect(out.result.observed?.controls).toHaveLength(2);
    expect(out.result.observed?.controls_truncated).toBe(true);
  });
});
