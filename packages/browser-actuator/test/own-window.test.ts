import { describe, expect, it } from "vitest";
import {
  ownWindowDispatch,
  OwnWindowTransportError,
  parseActionResult,
  type OwnWindowHost,
} from "../src/own-window.js";
import type { BrowserAction, BrowserActionRequest } from "@maman/contracts";

/**
 * The own-window transport: Maman driving its OWN browser window, with no
 * extension and no API keys.
 *
 * The properties under test are the ones the transport is uniquely responsible
 * for. Everything about whether an action is permitted lives in the pure core
 * above it; what lives here is "did this action reach the page it was authorised
 * for, and is the answer attributable".
 */

const ORIGIN = "https://acme.example";
const REQ_ID = "019fc4d0-130f-706e-b94e-42a86e9b3812";
const RUN_ID = "019fc4d0-130f-706e-b94e-42a86e9b3813";

function request(action: BrowserAction, allowed: string[] = [ORIGIN]): BrowserActionRequest {
  return {
    schema_version: 1,
    type: "browser_action_request",
    request_id: REQ_ID,
    run_id: RUN_ID,
    step_id: "fill-phone",
    issued_at: "2026-08-07T10:00:00.000Z",
    expires_at: "2026-08-07T10:00:30.000Z",
    consequential: false,
    authorization: "a".repeat(43),
    action,
    allowed_origins: allowed,
    user_present: true,
  } as unknown as BrowserActionRequest;
}

function host(over: Partial<OwnWindowHost> = {}): OwnWindowHost {
  return {
    evaluate: async () =>
      JSON.stringify({
        request_id: REQ_ID,
        outcome: "observed",
        observed: { value_after: "v", accessible_name: "Phone", match_count: 1 },
      }),
    navigate: async () => undefined,
    currentOrigin: async () => ORIGIN,
    ...over,
  };
}

const READ: BrowserAction = { kind: "read_field", target: { role: "textbox", name: "Phone" } };

describe("the window must be open and on an allowed origin", () => {
  it("refuses when no window is open", async () => {
    const dispatch = ownWindowDispatch(host({ currentOrigin: async () => null }));
    await expect(dispatch(request(READ))).rejects.toThrow(OwnWindowTransportError);
    await expect(dispatch(request(READ))).rejects.toThrow(/no_window/);
  });

  it("REFUSES when the window drifted to another origin after authorisation", async () => {
    // The core authorised this action for acme.example. Between then and now the
    // page navigated itself — a redirect, a meta refresh, a link the previous
    // action clicked. Without this check the next write lands on whatever page
    // happens to be there.
    let evaluated = false;
    const dispatch = ownWindowDispatch(
      host({
        currentOrigin: async () => "https://evil.example",
        evaluate: async () => {
          evaluated = true;
          return "{}";
        },
      }),
    );
    await expect(dispatch(request(READ))).rejects.toThrow(/origin_mismatch/);
    // And nothing was evaluated in the drifted page at all.
    expect(evaluated).toBe(false);
  });

  it("reads the origin from the HOST, never from the page", async () => {
    // A page can lie about document.location; the host's view of the webview
    // cannot be rewritten by page script. This asserts the transport asks the
    // host — if it ever asked the page, this test would need page cooperation.
    let asked = 0;
    const dispatch = ownWindowDispatch(
      host({
        currentOrigin: async () => {
          asked += 1;
          return ORIGIN;
        },
      }),
    );
    await dispatch(request(READ));
    expect(asked).toBeGreaterThan(0);
  });
});

describe("a broken bridge is a failure, never a silent no-change", () => {
  it("propagates an eval rejection as a transport error", async () => {
    const dispatch = ownWindowDispatch(
      host({
        evaluate: async () => {
          throw new Error("webview died");
        },
      }),
    );
    await expect(dispatch(request(READ))).rejects.toThrow(/bridge_failed/);
    await expect(dispatch(request(READ))).rejects.toThrow(/webview died/);
  });

  it("turns an unusable answer into a failed result, not a success", async () => {
    const dispatch = ownWindowDispatch(host({ evaluate: async () => "not json" }));
    const result = parseActionResult(await dispatch(request(READ)));
    expect(result.outcome).toBe("failed");
  });

  it("will not accept an answer belonging to a different request", async () => {
    const dispatch = ownWindowDispatch(
      host({
        evaluate: async () =>
          JSON.stringify({ request_id: "some-other-request", outcome: "applied" }),
      }),
    );
    const result = parseActionResult(await dispatch(request(READ)));
    expect(result.outcome).toBe("failed");
  });
});

describe("navigation is the host's job, not the page's", () => {
  const NAV: BrowserAction = { kind: "navigate", url: `${ORIGIN}/record/1` };

  it("navigates via the host and never evaluates page script", async () => {
    let evaluated = false;
    let navigatedTo = "";
    const dispatch = ownWindowDispatch(
      host({
        evaluate: async () => {
          evaluated = true;
          return "{}";
        },
        navigate: async (url) => {
          navigatedTo = url;
        },
      }),
    );
    const result = parseActionResult(await dispatch(request(NAV)));
    expect(result.outcome).toBe("observed");
    expect(navigatedTo).toBe(`${ORIGIN}/record/1`);
    expect(evaluated).toBe(false);
  });

  it("refuses a navigation whose TARGET is not allowed", async () => {
    const dispatch = ownWindowDispatch(host());
    await expect(
      dispatch(request({ kind: "navigate", url: "https://elsewhere.example/x" })),
    ).rejects.toThrow(/origin_mismatch/);
  });

  it("REFUSES when a redirect lands somewhere other than the target", async () => {
    // Continuing here would run the rest of the plan on an unexpected site.
    let calls = 0;
    const dispatch = ownWindowDispatch(
      host({
        currentOrigin: async () => {
          calls += 1;
          // allowed before navigating; hijacked after
          return calls === 1 ? ORIGIN : "https://phish.example";
        },
      }),
    );
    const result = parseActionResult(await dispatch(request(NAV)));
    expect(result.outcome).toBe("refused");
    expect(result.refusal_reason).toBe("origin_not_allowed");
  });
});

describe("the answer is reshaped into the wire contract", () => {
  it("passes a valid observation through the contract schema", async () => {
    const dispatch = ownWindowDispatch(host());
    const result = parseActionResult(await dispatch(request(READ)));
    expect(result.request_id).toBe(REQ_ID);
    expect(result.outcome).toBe("observed");
    expect(result.observed?.value_after).toBe("v");
    expect(result.observed?.resolved_name).toBe("Phone");
    // The origin on the record is the HOST's, not anything the page said.
    expect(result.observed?.origin).toBe(ORIGIN);
  });

  it("carries a refusal reason through, and only for refusals", async () => {
    const dispatch = ownWindowDispatch(
      host({
        evaluate: async () =>
          JSON.stringify({
            request_id: REQ_ID,
            run_id: RUN_ID,
            step_id: "fill-phone",
            outcome: "refused",
            refusal_reason: "secure_field",
          }),
      }),
    );
    const result = parseActionResult(await dispatch(request(READ)));
    expect(result.outcome).toBe("refused");
    expect(result.refusal_reason).toBe("secure_field");
  });

  it("reports an applied write with its read-back value", async () => {
    const dispatch = ownWindowDispatch(
      host({
        evaluate: async () =>
          JSON.stringify({
            request_id: REQ_ID,
            run_id: RUN_ID,
            step_id: "fill-phone",
            outcome: "applied",
            observed: {
              value_before: "555-0100",
              value_after: "555-0199",
              accessible_name: "Phone",
              match_count: 1,
            },
          }),
      }),
    );
    const result = parseActionResult(
      await dispatch(
        request({
          kind: "set_value",
          target: { role: "textbox", name: "Phone" },
          value: "555-0199",
        }),
      ),
    );
    expect(result.outcome).toBe("applied");
    expect(result.observed?.value_before).toBe("555-0100");
    expect(result.observed?.value_after).toBe("555-0199");
  });
});
