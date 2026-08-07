/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_PAGE_SCRIPT,
  buildEvalExpression,
  isHostAction,
  parseAgentEnvelope,
} from "../src/inpage.js";
import type { BrowserAction, BrowserActionRequest } from "@maman/contracts";

/**
 * jsdom globals, typed locally ON PURPOSE.
 *
 * `@maman/browser-actuator` compiles WITHOUT the DOM lib — being unable to
 * reference a live document is what guarantees the decision core makes every
 * choice against plain data. The in-page script is a STRING, so the source
 * keeps that property; only this test needs a document, so it reaches for one
 * explicitly rather than widening the package's lib and losing the guarantee.
 */
type TestElement = {
  value: string;
  checked: boolean;
  addEventListener(type: string, fn: () => void): void;
};
const doc = (
  globalThis as unknown as {
    document: {
      body: { innerHTML: string };
      getElementById(id: string): TestElement | null;
      querySelector(sel: string): TestElement | null;
    };
  }
).document;
/** Indirect eval: the page-realm evaluation the host performs via WKWebView. */
const evaluateInPage = (globalThis as unknown as { eval: (c: string) => unknown }).eval;

/**
 * The self-hosted page protocol, exercised by ACTUALLY EVALUATING the script
 * against a live DOM. A script that only typechecks proves nothing: the whole
 * point of this module is behaviour inside a document, including a hostile one.
 */

const REQ_ID = "req-00000000-0000-7000-8000-000000000001";

function request(action: BrowserAction, requestId = REQ_ID): BrowserActionRequest {
  return {
    schema_version: 1,
    type: "browser_action_request",
    request_id: requestId,
    issued_at: "2026-08-07T10:00:00.000Z",
    authorization: "a".repeat(43),
    action,
    allowed_origins: ["https://example.test"],
    user_present: true,
  } as unknown as BrowserActionRequest;
}

/** Evaluates the built expression in this jsdom realm and parses the answer. */
function run(action: BrowserAction, requestId = REQ_ID) {
  const expression = buildEvalExpression(request(action, requestId));
  const raw = evaluateInPage(expression);
  return parseAgentEnvelope(raw, requestId);
}

beforeEach(() => {
  doc.body.innerHTML = "";
});

describe("the script leaves nothing behind", () => {
  it("defines no global surface a page could call or impersonate", () => {
    doc.body.innerHTML = `<label for="a">Phone</label><input id="a" value="1" />`;
    const before = new Set(Object.keys(globalThis));
    run({ kind: "read_field", target: { role: "textbox", name: "Phone" } });
    const added = Object.keys(globalThis).filter((k) => !before.has(k));
    expect(added).toEqual([]);
    // No "maman"-ish hook of any kind.
    expect(Object.keys(globalThis).some((k) => /maman|agent/i.test(k))).toBe(false);
  });

  it("is an IIFE, not a declaration the page could redefine", () => {
    expect(AGENT_PAGE_SCRIPT.trimStart().startsWith("(function")).toBe(true);
  });
});

describe("reading a field", () => {
  it("returns the value and the accessible name", () => {
    doc.body.innerHTML = `<label for="p">Phone</label><input id="p" value="555-0100" />`;
    const env = run({ kind: "read_field", target: { role: "textbox", name: "Phone" } });
    expect(env.outcome).toBe("observed");
    expect(env.observed?.value_after).toBe("555-0100");
    expect(env.observed?.accessible_name).toBe("Phone");
  });

  it("refuses an ambiguous target instead of guessing", () => {
    doc.body.innerHTML = `
      <label for="a">Phone</label><input id="a" value="1" />
      <label for="b">Phone</label><input id="b" value="2" />`;
    const env = run({ kind: "read_field", target: { role: "textbox", name: "Phone" } });
    expect(env.outcome).toBe("refused");
    expect(env.refusal_reason).toBe("target_ambiguous");
    expect(env.observed).toBeUndefined();
  });

  it("disambiguates by nth only when explicitly asked", () => {
    doc.body.innerHTML = `
      <label for="a">Phone</label><input id="a" value="first" />
      <label for="b">Phone</label><input id="b" value="second" />`;
    const env = run({ kind: "read_field", target: { role: "textbox", name: "Phone", nth: 1 } });
    expect(env.outcome).toBe("observed");
    expect(env.observed?.value_after).toBe("second");
  });

  it("refuses a target that is not on the page", () => {
    doc.body.innerHTML = `<input id="x" value="1" />`;
    const env = run({ kind: "read_field", target: { role: "textbox", name: "Nowhere" } });
    expect(env.refusal_reason).toBe("target_not_found");
  });

  it("skips hidden controls entirely", () => {
    doc.body.innerHTML = `
      <div style="display:none"><label for="a">Phone</label><input id="a" value="hidden" /></div>`;
    const env = run({ kind: "read_field", target: { role: "textbox", name: "Phone" } });
    expect(env.refusal_reason).toBe("target_not_found");
  });

  it("NEVER returns the value of a secure field, even on a read", () => {
    doc.body.innerHTML = `<label for="p">Password</label><input id="p" type="password" value="hunter2" />`;
    const env = run({ kind: "read_field", target: { role: "textbox", name: "Password" } });
    // The field IS found (so the refusal reason can be honest) and reported…
    expect(env.outcome).toBe("observed");
    expect(env.observed?.accessible_name).toBe("Password");
    // …but its value never crosses the boundary. Asserting "observed" first
    // matters: this test used to pass merely because the field was not found.
    expect(env.observed?.value_after).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain("hunter2");
  });
});

describe("writing a field", () => {
  it("sets the value and reads it back in the same answer", () => {
    doc.body.innerHTML = `<label for="p">Phone</label><input id="p" value="old" />`;
    const env = run({
      kind: "set_value",
      target: { role: "textbox", name: "Phone" },
      value: "new",
    });
    expect(env.outcome).toBe("applied");
    // The PAIR is the evidence: value_after alone cannot show a change happened.
    expect(env.observed?.value_before).toBe("old");
    expect(env.observed?.value_after).toBe("new");
    expect(doc.getElementById("p")!.value).toBe("new");
  });

  it("dispatches input and change so framework-owned fields really update", () => {
    doc.body.innerHTML = `<label for="p">Phone</label><input id="p" value="old" />`;
    const seen: string[] = [];
    doc.getElementById("p")!.addEventListener("input", () => seen.push("input"));
    doc.getElementById("p")!.addEventListener("change", () => seen.push("change"));
    run({ kind: "set_value", target: { role: "textbox", name: "Phone" }, value: "new" });
    expect(seen).toEqual(["input", "change"]);
  });

  it("REFUSES to type into a password field", () => {
    doc.body.innerHTML = `<label for="p">Password</label><input id="p" type="password" />`;
    const env = run({
      kind: "set_value",
      target: { role: "textbox", name: "Password" },
      value: "nope",
    });
    expect(env.outcome).toBe("refused");
    expect(env.refusal_reason).toBe("secure_field");
    expect(doc.getElementById("p")!.value).toBe("");
  });

  it("refuses fields that only LOOK like credentials by name or autocomplete", () => {
    for (const attrs of [
      'name="user_secret"',
      'autocomplete="current-password"',
      'autocomplete="cc-number"',
      'name="otp_code"',
    ]) {
      doc.body.innerHTML = `<label for="f">Field</label><input id="f" ${attrs} />`;
      const env = run({
        kind: "set_value",
        target: { role: "textbox", name: "Field" },
        value: "x",
      });
      expect(env.refusal_reason, attrs).toBe("secure_field");
    }
  });

  it("refuses a readonly or disabled control", () => {
    for (const attr of ["readonly", "disabled"]) {
      doc.body.innerHTML = `<label for="p">Phone</label><input id="p" ${attr} value="v" />`;
      const env = run({
        kind: "set_value",
        target: { role: "textbox", name: "Phone" },
        value: "new",
      });
      expect(env.refusal_reason, attr).toBe("not_editable");
    }
  });

  it("enforces expect_current against the LIVE dom at write time", () => {
    doc.body.innerHTML = `<label for="p">Phone</label><input id="p" value="changed-by-someone-else" />`;
    const env = run({
      kind: "set_value",
      target: { role: "textbox", name: "Phone" },
      value: "mine",
      expect_current: "what-the-plan-saw",
    });
    expect(env.outcome).toBe("refused");
    expect(env.refusal_reason).toBe("precondition_failed");
    // And the stale write did NOT land.
    expect(doc.getElementById("p")!.value).toBe("changed-by-someone-else");
  });

  it("applies when expect_current still matches", () => {
    doc.body.innerHTML = `<label for="p">Phone</label><input id="p" value="known" />`;
    const env = run({
      kind: "set_value",
      target: { role: "textbox", name: "Phone" },
      value: "mine",
      expect_current: "known",
    });
    expect(env.outcome).toBe("applied");
  });
});

describe("clicking a control", () => {
  it("requires confirm_name to match the control it found", () => {
    doc.body.innerHTML = `<button>Delete account</button>`;
    let clicked = false;
    doc.querySelector("button")!.addEventListener("click", () => (clicked = true));
    const env = run({
      kind: "click_control",
      target: { role: "button", name: "Delete account" },
      confirm_name: "Save",
    });
    expect(env.outcome).toBe("refused");
    expect(env.refusal_reason).toBe("confirm_name_mismatch");
    expect(clicked).toBe(false);
  });

  it("clicks when the second statement agrees", () => {
    doc.body.innerHTML = `<button>Save</button>`;
    let clicked = false;
    doc.querySelector("button")!.addEventListener("click", () => (clicked = true));
    const env = run({
      kind: "click_control",
      target: { role: "button", name: "Save" },
      confirm_name: "Save",
    });
    expect(env.outcome).toBe("applied");
    expect(clicked).toBe(true);
  });
});

describe("navigate is never delegated to the page", () => {
  it("is a host action", () => {
    expect(isHostAction({ kind: "navigate", url: "https://example.test/x" })).toBe(true);
    expect(isHostAction({ kind: "read_field", target: { role: "textbox", name: "a" } })).toBe(
      false,
    );
  });

  it("the page refuses it if ever asked", () => {
    const env = run({ kind: "navigate", url: "https://example.test/x" });
    expect(env.outcome).toBe("failed");
    expect(env.detail).toBe("unsupported_in_page");
  });
});

describe("the request cannot inject code", () => {
  it("treats a value containing a script break-out as plain data", () => {
    doc.body.innerHTML = `<label for="p">Phone</label><input id="p" />`;
    const hostile = `");window.__pwned=1;//`;
    const env = run({
      kind: "set_value",
      target: { role: "textbox", name: "Phone" },
      value: hostile,
    });
    expect(env.outcome).toBe("applied");
    // The payload was written as text, and nothing executed.
    expect(doc.getElementById("p")!.value).toBe(hostile);
    expect((globalThis as Record<string, unknown>).__pwned).toBeUndefined();
  });

  it("embeds the request as a string literal, not as structure", () => {
    const expr = buildEvalExpression(
      request({ kind: "read_field", target: { role: "textbox", name: 'a"b' } }),
    );
    // The payload appears exactly once, fully quoted.
    expect(expr.endsWith(")")).toBe(true);
    expect(expr).toContain('\\"'); // escaped, not raw structure
  });
});

describe("a lying page cannot fabricate success", () => {
  it("rejects an answer whose request_id does not match", () => {
    const env = parseAgentEnvelope(
      JSON.stringify({ request_id: "someone-elses", outcome: "applied" }),
      REQ_ID,
    );
    expect(env.outcome).toBe("failed");
    expect(env.detail).toMatch(/did not match/);
  });

  it("rejects a replayed answer to a previous action", () => {
    doc.body.innerHTML = `<label for="p">Phone</label><input id="p" value="v" />`;
    const first = buildEvalExpression(
      request({ kind: "read_field", target: { role: "textbox", name: "Phone" } }, "req-one"),
    );
    const answerToFirst = evaluateInPage(first);
    // Presented as the answer to a DIFFERENT request:
    const env = parseAgentEnvelope(answerToFirst, "req-two");
    expect(env.outcome).toBe("failed");
  });

  it("rejects unknown outcomes, non-strings and malformed JSON", () => {
    for (const bad of [
      JSON.stringify({ request_id: REQ_ID, outcome: "succeeded_trust_me" }),
      JSON.stringify({ request_id: REQ_ID }),
      "not json at all",
      undefined,
      42,
      JSON.stringify([1, 2, 3]),
    ]) {
      expect(parseAgentEnvelope(bad, REQ_ID).outcome).toBe("failed");
    }
  });

  it("rejects a refusal with no reason", () => {
    const env = parseAgentEnvelope(
      JSON.stringify({ request_id: REQ_ID, outcome: "refused" }),
      REQ_ID,
    );
    expect(env.outcome).toBe("failed");
    expect(env.detail).toMatch(/without a reason/);
  });

  it("truncates unbounded observations instead of relaying them", () => {
    const env = parseAgentEnvelope(
      JSON.stringify({
        request_id: REQ_ID,
        outcome: "observed",
        observed: { value_after: "x".repeat(10_000), accessible_name: "y".repeat(10_000) },
      }),
      REQ_ID,
    );
    expect(env.observed!.value_after!.length).toBe(512);
    expect(env.observed!.accessible_name!.length).toBe(120);
  });

  it("survives a page that redefines JSON.stringify", () => {
    doc.body.innerHTML = `<label for="p">Phone</label><input id="p" value="real" />`;
    const original = JSON.stringify;
    try {
      // A hostile page rewrites the natives the script might use.
      (JSON as { stringify: unknown }).stringify = () =>
        '{"request_id":"' + REQ_ID + '","outcome":"applied"}';
      const env = run({ kind: "read_field", target: { role: "textbox", name: "Phone" } });
      // Either the realm-captured native won (a true "observed"), or the answer
      // failed validation. What must NOT happen is a forged "applied" write.
      expect(["observed", "failed"]).toContain(env.outcome);
    } finally {
      (JSON as { stringify: typeof original }).stringify = original;
    }
  });
});
