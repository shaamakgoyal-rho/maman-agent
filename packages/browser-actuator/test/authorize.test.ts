import { describe, expect, it } from "vitest";
import type { BrowserAction } from "@maman/contracts";
import { authorizeIssue, MAX_AUTHORIZATION_WINDOW_MS, type IssueInput } from "../src/index.js";

const TOKEN = "b".repeat(48);
const ISSUED = new Date("2026-08-05T12:00:00.000Z");

const WRITE: BrowserAction = {
  kind: "set_value",
  target: { role: "textbox", name: "Close date" },
  value: "2026-12-31",
};
const READ: BrowserAction = {
  kind: "read_field",
  target: { role: "textbox", name: "Close date" },
};

function input(over: Partial<IssueInput> = {}): IssueInput {
  return {
    routedSource: "browser_extension",
    action: WRITE,
    mode: "supervised",
    allowSupervisedBrowserWrites: true,
    approvalGranted: true,
    userPresent: true,
    allowedOrigins: ["https://acme.my.salesforce.com"],
    authorization: TOKEN,
    spentAuthorizations: new Set<string>(),
    issuedAt: ISSUED,
    expiresAt: new Date(ISSUED.getTime() + 60_000),
    ...over,
  };
}

describe("authorizeIssue", () => {
  it("issues a supervised, approved, present write", () => {
    expect(authorizeIssue(input())).toEqual({ ok: true });
  });

  it("only handles the browser lane", () => {
    expect(authorizeIssue(input({ routedSource: "api" }))).toEqual({
      ok: false,
      reason: "wrong_source",
    });
  });

  it("refuses with nothing to check the origin against", () => {
    expect(authorizeIssue(input({ allowedOrigins: [] }))).toEqual({
      ok: false,
      reason: "no_allowed_origins",
    });
  });

  it("refuses a weak token", () => {
    expect(authorizeIssue(input({ authorization: "short" }))).toEqual({
      ok: false,
      reason: "authorization_too_weak",
    });
  });

  it("refuses a token that has already been spent, so a request runs at most once", () => {
    expect(authorizeIssue(input({ spentAuthorizations: new Set([TOKEN]) }))).toEqual({
      ok: false,
      reason: "authorization_reused",
    });
  });

  it("bounds the validity window", () => {
    const tooLong = new Date(ISSUED.getTime() + MAX_AUTHORIZATION_WINDOW_MS + 1);
    expect(authorizeIssue(input({ expiresAt: tooLong }))).toEqual({
      ok: false,
      reason: "expiry_window_too_long",
    });
    const atLimit = new Date(ISSUED.getTime() + MAX_AUTHORIZATION_WINDOW_MS);
    expect(authorizeIssue(input({ expiresAt: atLimit }))).toEqual({ ok: true });
  });

  describe("write gates — each is independently sufficient to refuse", () => {
    it("a shadow run never writes", () => {
      expect(authorizeIssue(input({ mode: "shadow" }))).toEqual({
        ok: false,
        reason: "shadow_run_never_writes",
      });
    });

    it("policy must have enabled supervised browser writes", () => {
      expect(authorizeIssue(input({ allowSupervisedBrowserWrites: false }))).toEqual({
        ok: false,
        reason: "policy_forbids_browser_writes",
      });
    });

    it("this step must be approved", () => {
      expect(authorizeIssue(input({ approvalGranted: false }))).toEqual({
        ok: false,
        reason: "approval_missing",
      });
    });

    it("the user must be present", () => {
      expect(authorizeIssue(input({ userPresent: false }))).toEqual({
        ok: false,
        reason: "user_absent",
      });
    });

    it("an active run still needs approval and presence", () => {
      expect(authorizeIssue(input({ mode: "active", approvalGranted: false }))).toEqual({
        ok: false,
        reason: "approval_missing",
      });
      expect(authorizeIssue(input({ mode: "active", userPresent: false }))).toEqual({
        ok: false,
        reason: "user_absent",
      });
    });
  });

  describe("reads", () => {
    it("are issued from a shadow run with no approval and no user present", () => {
      expect(
        authorizeIssue(
          input({
            action: READ,
            mode: "shadow",
            allowSupervisedBrowserWrites: false,
            approvalGranted: false,
            userPresent: false,
          }),
        ),
      ).toEqual({ ok: true });
    });

    it("still need a fresh, unspent token", () => {
      expect(
        authorizeIssue(input({ action: READ, spentAuthorizations: new Set([TOKEN]) })),
      ).toEqual({ ok: false, reason: "authorization_reused" });
    });
  });

  it("gates every write verb, not just set_value", () => {
    const click: BrowserAction = {
      kind: "click_control",
      target: { role: "button", name: "Save" },
      confirm_name: "Save",
    };
    const select: BrowserAction = {
      kind: "select_option",
      target: { role: "combobox", name: "Stage" },
      option: "Closed Won",
    };
    for (const action of [click, select]) {
      expect(authorizeIssue(input({ action, mode: "shadow" }))).toEqual({
        ok: false,
        reason: "shadow_run_never_writes",
      });
    }
  });

  it("treats navigate and focus_field as reads", () => {
    const nav: BrowserAction = { kind: "navigate", url: "https://acme.my.salesforce.com/x" };
    const focus: BrowserAction = {
      kind: "focus_field",
      target: { role: "textbox", name: "Close date" },
    };
    for (const action of [nav, focus]) {
      expect(authorizeIssue(input({ action, mode: "shadow" }))).toEqual({ ok: true });
    }
  });
});
