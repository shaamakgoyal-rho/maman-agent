import { describe, expect, it } from "vitest";
import {
  browserActionResultSchema,
  type BrowserAction,
  type BrowserActionResult,
} from "@maman/contracts";
import { verifyWrite } from "../src/index.js";

const ORIGIN = "https://acme.my.salesforce.com";

const WRITE: BrowserAction = {
  kind: "set_value",
  target: { role: "textbox", name: "Close date" },
  value: "2026-12-31",
};

function result(over: Partial<BrowserActionResult> = {}): BrowserActionResult {
  return browserActionResultSchema.parse({
    schema_version: 1,
    type: "browser_action_result",
    request_id: "018f0000-0000-7000-8000-000000000001",
    run_id: "018f0000-0000-7000-8000-000000000002",
    step_id: "step-1",
    outcome: "applied",
    observed: {
      resolved_name: "Close date",
      value_before: "2026-09-30",
      value_after: "2026-12-31",
      match_count: 1,
      origin: ORIGIN,
    },
    completed_at: "2026-08-05T12:00:01.000Z",
    ...over,
  });
}

describe("verifyWrite", () => {
  it("passes only on a read-back that matches what was asked for", () => {
    expect(verifyWrite(WRITE, result())).toEqual({ verified: true });
  });

  it("fails when the page holds something else afterwards", () => {
    const r = result({
      observed: {
        resolved_name: "Close date",
        value_after: "2026-09-30",
        match_count: 1,
        origin: ORIGIN,
      },
    });
    expect(verifyWrite(WRITE, r)).toEqual({ verified: false, reason: "value_mismatch" });
  });

  it("does not accept the executor's own word as verification", () => {
    // outcome "applied" with nothing read back is exactly the case where trusting
    // the executor would hide a failed write.
    const r = result({ observed: undefined });
    expect(verifyWrite(WRITE, r)).toEqual({ verified: false, reason: "no_observation" });
  });

  it("fails a result that never claimed to be applied", () => {
    const refused = result({ outcome: "refused", refusal_reason: "secure_field" });
    expect(verifyWrite(WRITE, refused)).toEqual({ verified: false, reason: "not_applied" });
  });

  it("verifies select_option against the chosen option", () => {
    const select: BrowserAction = {
      kind: "select_option",
      target: { role: "combobox", name: "Stage" },
      option: "Closed Won",
    };
    const ok = result({
      observed: {
        resolved_name: "Stage",
        value_after: "Closed Won",
        match_count: 1,
        origin: ORIGIN,
      },
    });
    expect(verifyWrite(select, ok)).toEqual({ verified: true });
  });

  it("reports that a click needs a separate read rather than passing itself", () => {
    const click: BrowserAction = {
      kind: "click_control",
      target: { role: "button", name: "Save" },
      confirm_name: "Save",
    };
    const clicked = result({
      observed: { resolved_name: "Save", match_count: 1, origin: ORIGIN },
    });
    expect(verifyWrite(click, clicked)).toEqual({
      verified: false,
      reason: "requires_independent_read",
    });
  });

  it("flags a click that landed on a differently-named control", () => {
    const click: BrowserAction = {
      kind: "click_control",
      target: { role: "button", name: "Save" },
      confirm_name: "Save",
    };
    const elsewhere = result({
      observed: { resolved_name: "Delete", match_count: 1, origin: ORIGIN },
    });
    expect(verifyWrite(click, elsewhere)).toEqual({ verified: false, reason: "value_mismatch" });
  });

  it("refuses to be used on a read", () => {
    const read: BrowserAction = {
      kind: "read_field",
      target: { role: "textbox", name: "Close date" },
    };
    expect(verifyWrite(read, result())).toEqual({ verified: false, reason: "not_a_write" });
  });
});
