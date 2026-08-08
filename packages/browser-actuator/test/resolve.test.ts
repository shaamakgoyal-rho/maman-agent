import { describe, expect, it } from "vitest";
import {
  browserActionRequestSchema,
  browserControlSchema,
  type BrowserAction,
  type BrowserActionRequest,
} from "@maman/contracts";
import {
  listControls,
  matchingControls,
  namesMatch,
  normalizeName,
  originAllowed,
  originOf,
  resolveRequest,
  valuesMatch,
  type CandidateControl,
  type PageContext,
} from "../src/index.js";

const ORIGIN = "https://acme.my.salesforce.com";
const TOKEN = "a".repeat(48);
const NOW = new Date("2026-08-05T12:00:00.000Z");

function request(action: BrowserAction, over: Partial<BrowserActionRequest> = {}) {
  const base = {
    schema_version: 1 as const,
    type: "browser_action_request" as const,
    request_id: "018f0000-0000-7000-8000-000000000001",
    run_id: "018f0000-0000-7000-8000-000000000002",
    step_id: "step-1",
    action,
    authorization: TOKEN,
    allowed_origins: [ORIGIN],
    consequential: !["read_field", "focus_field", "list_controls"].includes(action.kind),
    issued_at: "2026-08-05T11:59:30.000Z",
    expires_at: "2026-08-05T12:01:00.000Z",
    ...over,
  };
  // Every fixture goes through the real schema: a test that exercises a request
  // shape the contract would reject proves nothing about production.
  return browserActionRequestSchema.parse(base);
}

function control(over: Partial<CandidateControl> = {}): CandidateControl {
  return {
    role: "textbox",
    accessibleName: "Close date",
    value: "2026-09-30",
    editable: true,
    secure: false,
    visible: true,
    ...over,
  };
}

function page(over: Partial<PageContext> = {}): PageContext {
  return {
    origin: ORIGIN,
    privateWindow: false,
    userPresent: true,
    paused: false,
    controls: [control()],
    ...over,
  };
}

const validToken = (t: string) => t === TOKEN;

describe("normalizeName", () => {
  it("strips form decoration that is presentation, not identity", () => {
    expect(normalizeName("  Close Date * ")).toBe("close date");
    expect(normalizeName("Close date:")).toBe("close date");
    expect(normalizeName("Close date")).toBe("close date");
    expect(normalizeName("Close   date")).toBe("close date");
  });

  it("does not match on substrings", () => {
    expect(namesMatch("Delete", "Delete all records")).toBe(false);
    expect(namesMatch("Delete all records", "Delete")).toBe(false);
  });
});

describe("originAllowed", () => {
  it("compares origins exactly, defeating suffix and prefix lookalikes", () => {
    expect(originAllowed(ORIGIN, [ORIGIN])).toBe(true);
    expect(originAllowed("https://evil-my.salesforce.com", [ORIGIN])).toBe(false);
    expect(originAllowed("https://acme.my.salesforce.com.evil.test", [ORIGIN])).toBe(false);
    // Same host over http is a different origin, and is not allowed.
    expect(originAllowed("http://acme.my.salesforce.com", [ORIGIN])).toBe(false);
  });

  it("treats an unparseable origin as matching nothing", () => {
    expect(originOf("not a url")).toBe("");
    expect(originAllowed("", [""])).toBe(false);
    expect(originAllowed("not a url", ["not a url"])).toBe(false);
  });
});

describe("valuesMatch", () => {
  it("never lets an unread value satisfy a precondition", () => {
    expect(valuesMatch("x", undefined)).toBe(false);
    expect(valuesMatch("x", " x ")).toBe(true);
  });
});

describe("matchingControls", () => {
  it("ignores invisible controls and other roles", () => {
    const controls = [
      control({ accessibleName: "Close date", visible: false }),
      control({ accessibleName: "Close date", role: "button" }),
      control({ accessibleName: "Close date" }),
    ];
    expect(matchingControls({ role: "textbox", name: "Close date" }, controls)).toHaveLength(1);
  });
});

describe("resolveRequest — context gates, in priority order", () => {
  const read: BrowserAction = {
    kind: "read_field",
    target: { role: "textbox", name: "Close date" },
  };

  it("honours a user pause above everything else, including a bad token", () => {
    const r = resolveRequest(request(read), page({ paused: true }), NOW, () => false);
    expect(r).toMatchObject({ ok: false, refusal: "paused_by_user" });
  });

  it("refuses an unknown token", () => {
    const r = resolveRequest(request(read), page(), NOW, () => false);
    expect(r).toMatchObject({ ok: false, refusal: "not_authorized" });
  });

  it("refuses an expired token, reported identically to an unknown one", () => {
    const late = new Date("2026-08-05T12:01:00.001Z");
    const r = resolveRequest(request(read), page(), late, validToken);
    expect(r).toMatchObject({ ok: false, refusal: "not_authorized" });
  });

  it("refuses a write that claims to be inconsequential", () => {
    const write: BrowserAction = {
      kind: "set_value",
      target: { role: "textbox", name: "Close date" },
      value: "2026-12-31",
    };
    const r = resolveRequest(request(write, { consequential: false }), page(), NOW, validToken);
    expect(r).toMatchObject({ ok: false, refusal: "not_authorized" });
  });

  it("never actuates a private window", () => {
    const r = resolveRequest(request(read), page({ privateWindow: true }), NOW, validToken);
    expect(r).toMatchObject({ ok: false, refusal: "private_window" });
  });

  it("refuses a tab whose origin is not allow-listed", () => {
    const r = resolveRequest(
      request(read),
      page({ origin: "https://other.test" }),
      NOW,
      validToken,
    );
    expect(r).toMatchObject({ ok: false, refusal: "origin_not_allowed" });
  });

  it("gates writes on user presence but allows reads without it", () => {
    const write: BrowserAction = {
      kind: "set_value",
      target: { role: "textbox", name: "Close date" },
      value: "2026-12-31",
    };
    const absent = page({ userPresent: false });
    expect(resolveRequest(request(write), absent, NOW, validToken)).toMatchObject({
      ok: false,
      refusal: "user_absent",
    });
    expect(resolveRequest(request(read), absent, NOW, validToken)).toMatchObject({ ok: true });
  });
});

describe("resolveRequest — navigation", () => {
  it("allows a navigation inside the allow-list and refuses one outside it", () => {
    const ok: BrowserAction = { kind: "navigate", url: `${ORIGIN}/lightning/o/Opportunity/list` };
    expect(resolveRequest(request(ok), page(), NOW, validToken)).toMatchObject({ ok: true });

    const away: BrowserAction = { kind: "navigate", url: "https://elsewhere.test/x" };
    expect(resolveRequest(request(away), page(), NOW, validToken)).toMatchObject({
      ok: false,
      refusal: "origin_not_allowed",
    });
  });

  it("checks the destination, not the current tab", () => {
    const ok: BrowserAction = { kind: "navigate", url: `${ORIGIN}/x` };
    const elsewhere = page({ origin: "https://start.test" });
    expect(resolveRequest(request(ok), elsewhere, NOW, validToken)).toMatchObject({ ok: true });
  });
});

describe("resolveRequest — target resolution", () => {
  const target = { role: "textbox" as const, name: "Close date" };

  it("refuses when nothing matches", () => {
    const r = resolveRequest(
      request({ kind: "read_field", target: { role: "textbox", name: "Nope" } }),
      page(),
      NOW,
      validToken,
    );
    expect(r).toMatchObject({ ok: false, refusal: "no_match", matchCount: 0 });
  });

  it("refuses ambiguity rather than taking the first hit", () => {
    const p = page({ controls: [control(), control()] });
    const r = resolveRequest(request({ kind: "read_field", target }), p, NOW, validToken);
    expect(r).toMatchObject({ ok: false, refusal: "ambiguous_match", matchCount: 2 });
  });

  it("accepts an explicit nth for a genuinely repeated control", () => {
    const p = page({
      controls: [control({ value: "row-0" }), control({ value: "row-1" })],
    });
    const r = resolveRequest(
      request({ kind: "read_field", target: { ...target, nth: 1 } }),
      p,
      NOW,
      validToken,
    );
    expect(r).toMatchObject({ ok: true, control: { value: "row-1" } });
  });

  it("refuses an nth past the end", () => {
    const r = resolveRequest(
      request({ kind: "read_field", target: { ...target, nth: 5 } }),
      page(),
      NOW,
      validToken,
    );
    expect(r).toMatchObject({ ok: false, refusal: "no_match" });
  });

  it("refuses a secure field for reads as well as writes", () => {
    const p = page({ controls: [control({ secure: true })] });
    expect(
      resolveRequest(request({ kind: "read_field", target }), p, NOW, validToken),
    ).toMatchObject({ ok: false, refusal: "secure_field" });
    expect(
      resolveRequest(
        request({ kind: "set_value", target, value: "2026-12-31" }),
        p,
        NOW,
        validToken,
      ),
    ).toMatchObject({ ok: false, refusal: "secure_field" });
  });

  it("refuses to write a non-editable control but will still read it", () => {
    const p = page({ controls: [control({ editable: false })] });
    expect(
      resolveRequest(
        request({ kind: "set_value", target, value: "2026-12-31" }),
        p,
        NOW,
        validToken,
      ),
    ).toMatchObject({ ok: false, refusal: "target_not_editable" });
    expect(
      resolveRequest(request({ kind: "read_field", target }), p, NOW, validToken),
    ).toMatchObject({ ok: true });
  });
});

describe("resolveRequest — write preconditions", () => {
  const target = { role: "textbox" as const, name: "Close date" };

  it("refuses a stale plan instead of overwriting the current value", () => {
    const r = resolveRequest(
      request({
        kind: "set_value",
        target,
        value: "2026-12-31",
        expect_current: "2026-06-30",
      }),
      page(),
      NOW,
      validToken,
    );
    expect(r).toMatchObject({ ok: false, refusal: "precondition_failed" });
  });

  it("applies when the precondition holds", () => {
    const r = resolveRequest(
      request({
        kind: "set_value",
        target,
        value: "2026-12-31",
        expect_current: "2026-09-30",
      }),
      page(),
      NOW,
      validToken,
    );
    expect(r).toMatchObject({ ok: true });
  });

  it("refuses when the field's value could not be read at all", () => {
    // The key is absent, not set to undefined: that is what an adapter produces for
    // a control it could not read.
    const unread: CandidateControl = { ...control() };
    delete unread.value;
    const p = page({ controls: [unread] });
    const r = resolveRequest(
      request({ kind: "set_value", target, value: "x", expect_current: "y" }),
      p,
      NOW,
      validToken,
    );
    expect(r).toMatchObject({ ok: false, refusal: "precondition_failed" });
  });

  it("refuses a click whose confirm_name disagrees with the resolved control", () => {
    const p = page({ controls: [control({ role: "button", accessibleName: "Delete all" })] });
    const r = resolveRequest(
      request({
        kind: "click_control",
        target: { role: "button", name: "Delete all" },
        confirm_name: "Save",
      }),
      p,
      NOW,
      validToken,
    );
    expect(r).toMatchObject({ ok: false, refusal: "confirm_name_mismatch" });
  });

  it("allows a click whose two statements of intent agree", () => {
    const p = page({ controls: [control({ role: "button", accessibleName: "Save" })] });
    const r = resolveRequest(
      request({
        kind: "click_control",
        target: { role: "button", name: "Save" },
        confirm_name: "Save",
      }),
      p,
      NOW,
      validToken,
    );
    expect(r).toMatchObject({ ok: true });
  });

  it("resolves select_option and focus_field without extra preconditions", () => {
    const p = page({ controls: [control({ role: "combobox", accessibleName: "Stage" })] });
    expect(
      resolveRequest(
        request({
          kind: "select_option",
          target: { role: "combobox", name: "Stage" },
          option: "Closed Won",
        }),
        p,
        NOW,
        validToken,
      ),
    ).toMatchObject({ ok: true });
    expect(
      resolveRequest(
        request({ kind: "focus_field", target: { role: "combobox", name: "Stage" } }),
        p,
        NOW,
        validToken,
      ),
    ).toMatchObject({ ok: true });
  });
});

/**
 * The verb that lets an agent find its own target.
 *
 * Every other action must already know the accessible name it wants, so before
 * this the only source of that name was a human typing it in. The safety
 * question is therefore not "may the agent look" but "what may looking return".
 */
describe("list_controls: the page's shape, never its contents", () => {
  const LIST: BrowserAction = { kind: "list_controls", roles: ["textbox"], limit: 40 };

  it("passes every gate the other verbs pass", () => {
    // Looking is a read, but it is not ungated: a paused run, a spent token, a
    // private window and a foreign origin each refuse it.
    expect(resolveRequest(request(LIST), page({ paused: true }), NOW, validToken)).toMatchObject({
      ok: false,
      refusal: "paused_by_user",
    });
    expect(resolveRequest(request(LIST), page(), NOW, () => false)).toMatchObject({
      ok: false,
      refusal: "not_authorized",
    });
    expect(
      resolveRequest(request(LIST), page({ privateWindow: true }), NOW, validToken),
    ).toMatchObject({ ok: false, refusal: "private_window" });
    expect(
      resolveRequest(request(LIST), page({ origin: "https://elsewhere.test" }), NOW, validToken),
    ).toMatchObject({ ok: false, refusal: "origin_not_allowed" });
  });

  it("does not need the user present, because it changes nothing", () => {
    expect(
      resolveRequest(request(LIST), page({ userPresent: false }), NOW, validToken),
    ).toMatchObject({ ok: true });
  });

  it("RETURNS NO VALUES — the form's shape is not the record's contents", () => {
    const listed = listControls([control({ value: "555-0100" })], ["textbox"], 40);
    expect(listed.controls).toEqual([
      { role: "textbox", name: "Close date", secure: false, editable: true, duplicate_count: 1 },
    ]);
    // Stated against the serialised form too: no key anywhere holds the value.
    expect(JSON.stringify(listed)).not.toContain("555-0100");
  });

  it("returns only the roles that were asked for", () => {
    const listed = listControls(
      [
        control({ role: "textbox", accessibleName: "Phone" }),
        control({ role: "button", accessibleName: "Delete account" }),
      ],
      ["textbox"],
      40,
    );
    expect(listed.controls.map((c) => c.name)).toEqual(["Phone"]);
  });

  it("drops a control whose NAME is secret-shaped", () => {
    // The page chooses these strings, and this listing is relayed, receipted and
    // shown to the user. Losing a possible target is the cheaper mistake.
    const listed = listControls(
      [control({ accessibleName: `ghp_${"a".repeat(36)}` }), control({ accessibleName: "Phone" })],
      ["textbox"],
      40,
    );
    expect(listed.controls.map((c) => c.name)).toEqual(["Phone"]);
  });

  it("lists a password field rather than hiding it", () => {
    // Omitting it would read as "not on this page", which sends the user off to
    // configure something that is right in front of them. The agent needs to be
    // able to see it and route around it.
    const listed = listControls(
      [control({ accessibleName: "Password", secure: true })],
      ["textbox"],
      40,
    );
    expect(listed.controls[0]).toMatchObject({ name: "Password", secure: true });
  });

  it("skips invisible controls and unnamed ones", () => {
    const listed = listControls(
      [
        control({ accessibleName: "Hidden field", visible: false }),
        control({ accessibleName: "   " }),
        control({ accessibleName: "Phone" }),
      ],
      ["textbox"],
      40,
    );
    expect(listed.controls.map((c) => c.name)).toEqual(["Phone"]);
  });

  it("collapses repeats into a count instead of spending the budget on them", () => {
    const rows = Array.from({ length: 12 }, () => control({ accessibleName: "Amount" }));
    const listed = listControls([...rows, control({ accessibleName: "Total" })], ["textbox"], 40);
    expect(listed.controls).toHaveLength(2);
    expect(listed.controls[0]).toMatchObject({ name: "Amount", duplicate_count: 12 });
    expect(listed.truncated).toBe(false);
  });

  it("reports a repeat conservatively when one of them is not editable", () => {
    // A caller addressing "Amount" without an `nth` could land on the readonly
    // one, so the listing must not promise it is writable.
    const listed = listControls(
      [
        control({ accessibleName: "Amount" }),
        control({ accessibleName: "Amount", editable: false }),
      ],
      ["textbox"],
      40,
    );
    expect(listed.controls[0]).toMatchObject({ editable: false, duplicate_count: 2 });
  });

  it("SAYS when it truncated, so 'not on this page' is never inferred from a partial list", () => {
    const many = Array.from({ length: 9 }, (_, i) => control({ accessibleName: `Field ${i}` }));
    const listed = listControls(many, ["textbox"], 4);
    expect(listed.controls).toHaveLength(4);
    expect(listed.truncated).toBe(true);
  });

  it("stays inside the contract's own bounds on a hostile page", () => {
    // 400 identical controls must not produce a duplicate_count the schema
    // rejects — the whole listing would be lost to one pathological page.
    const many = Array.from({ length: 400 }, () => control({ accessibleName: "Row" }));
    const listed = listControls(many, ["textbox"], 40);
    expect(listed.controls[0]!.duplicate_count).toBe(200);
    expect(browserControlSchema.safeParse(listed.controls[0]).success).toBe(true);
  });
});
