import { describe, expect, it, vi } from "vitest";
import {
  browserActionRequestSchema,
  browserActionResultSchema,
  type BrowserAction,
} from "@maman/contracts";
import type { ActuationOutput } from "../src/lib/actuate.js";
import { dispatchBrowserAction, type DispatchDeps, type TabInfo } from "../src/lib/dispatch.js";

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
    consequential: action.kind === "set_value",
    issued_at: "2026-08-05T11:59:30.000Z",
    expires_at: "2026-08-05T12:01:00.000Z",
    ...over,
  });
}

const READ: BrowserAction = {
  kind: "read_field",
  target: { role: "textbox", name: "Close date" },
};

function tab(over: Partial<TabInfo> = {}): TabInfo {
  return {
    id: 1,
    url: `${ORIGIN}/lightning/r/Opportunity/1`,
    active: true,
    incognito: false,
    windowId: 10,
    ...over,
  };
}

const SENT: ActuationOutput = {
  ok: true,
  result: browserActionResultSchema.parse({
    schema_version: 1,
    type: "browser_action_result",
    request_id: "018f0000-0000-7000-8000-000000000001",
    run_id: "018f0000-0000-7000-8000-000000000002",
    step_id: "step-1",
    outcome: "observed",
    completed_at: "2026-08-05T12:00:01.000Z",
  }),
};

function deps(over: Partial<DispatchDeps> = {}) {
  const spent = new Set<string>();
  const base: DispatchDeps = {
    listTabs: async () => [tab()],
    isWindowFocused: async () => true,
    enabledDomains: async () => ["salesforce.com"],
    isRunPaused: async () => false,
    spendAuthorization: async (t) => (spent.has(t) ? false : (spent.add(t), true)),
    sendToTab: vi.fn(async () => SENT),
    navigate: vi.fn(async () => {}),
    now: () => NOW,
    ...over,
  };
  return base;
}

describe("dispatchBrowserAction", () => {
  it("rejects a request the contract does not accept", async () => {
    expect(await dispatchBrowserAction({ bogus: 1 }, deps())).toEqual({
      ok: false,
      error: "malformed_request",
    });
  });

  it("hands an approved read to the content script of the frontmost matching tab", async () => {
    const d = deps();
    const out = await dispatchBrowserAction(request(READ), d);
    expect(out).toEqual(SENT);
    expect(d.sendToTab).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ step_id: "step-1" }),
      expect.objectContaining({ origin: ORIGIN, userPresent: true, paused: false }),
    );
  });

  it("refuses a paused run before spending the token", async () => {
    const spend = vi.fn(async () => true);
    const d = deps({ isRunPaused: async () => true, spendAuthorization: spend });
    const out = await dispatchBrowserAction(request(READ), d);
    expect(out.ok && out.result.refusal_reason).toBe("paused_by_user");
    expect(spend).not.toHaveBeenCalled();
  });

  it("performs a request at most once", async () => {
    const d = deps();
    const req = request(READ);
    expect((await dispatchBrowserAction(req, d)).ok).toBe(true);
    const second = await dispatchBrowserAction(req, d);
    expect(second.ok && second.result.refusal_reason).toBe("not_authorized");
  });

  it("burns the token even when no tab is available, rather than leaving it live", async () => {
    const d = deps({ listTabs: async () => [] });
    const first = await dispatchBrowserAction(request(READ), d);
    expect(first.ok && first.result.refusal_reason).toBe("origin_not_allowed");
    // Same token again: already spent.
    const retry = await dispatchBrowserAction(request(READ), {
      ...d,
      listTabs: async () => [tab()],
      spendAuthorization: d.spendAuthorization,
    });
    expect(retry.ok && retry.result.refusal_reason).toBe("not_authorized");
  });

  it("refuses a tab on an allow-listed origin whose domain the user never enabled", async () => {
    const d = deps({ enabledDomains: async () => [] });
    const out = await dispatchBrowserAction(request(READ), d);
    expect(out.ok && out.result.refusal_reason).toBe("origin_not_allowed");
    expect(d.sendToTab).not.toHaveBeenCalled();
  });

  it("refuses when the only matching tab is a private window", async () => {
    const d = deps({ listTabs: async () => [tab({ incognito: true })] });
    const out = await dispatchBrowserAction(request(READ), d);
    expect(out.ok && out.result.refusal_reason).toBe("private_window");
    expect(d.sendToTab).not.toHaveBeenCalled();
  });

  it("uses a non-private tab when both are open", async () => {
    const d = deps({
      listTabs: async () => [tab({ id: 2, incognito: true }), tab({ id: 3 })],
    });
    await dispatchBrowserAction(request(READ), d);
    expect(d.sendToTab).toHaveBeenCalledWith(3, expect.anything(), expect.anything());
  });

  it("reports the user as absent when no matching tab is frontmost", async () => {
    const d = deps({ listTabs: async () => [tab({ active: false })] });
    await dispatchBrowserAction(request(READ), d);
    expect(d.sendToTab).toHaveBeenCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({ userPresent: false }),
    );
  });

  it("treats an active tab in an unfocused window as not frontmost", async () => {
    const d = deps({ isWindowFocused: async () => false });
    await dispatchBrowserAction(request(READ), d);
    expect(d.sendToTab).toHaveBeenCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({ userPresent: false }),
    );
  });

  it("prefers the frontmost tab over an earlier background one", async () => {
    const d = deps({
      listTabs: async () => [tab({ id: 5, active: false }), tab({ id: 6, active: true })],
    });
    await dispatchBrowserAction(request(READ), d);
    expect(d.sendToTab).toHaveBeenCalledWith(
      6,
      expect.anything(),
      expect.objectContaining({ userPresent: true }),
    );
  });

  describe("navigation", () => {
    it("navigates a tab already on an enabled, allow-listed origin", async () => {
      const d = deps();
      const out = await dispatchBrowserAction(
        request({ kind: "navigate", url: `${ORIGIN}/lightning/o/Opportunity/list` }),
        d,
      );
      expect(d.navigate).toHaveBeenCalledWith(1, `${ORIGIN}/lightning/o/Opportunity/list`);
      expect(out.ok && out.result.outcome).toBe("observed");
      expect(d.sendToTab).not.toHaveBeenCalled();
    });

    it("refuses a destination outside the allow-list even from an allowed tab", async () => {
      const d = deps();
      const out = await dispatchBrowserAction(
        request({ kind: "navigate", url: "https://elsewhere.test/x" }),
        d,
      );
      expect(out.ok && out.result.refusal_reason).toBe("origin_not_allowed");
      expect(d.navigate).not.toHaveBeenCalled();
    });

    it("refuses a navigation when the user has no tab open on an allowed origin", async () => {
      const d = deps({ listTabs: async () => [tab({ url: "https://unrelated.test/" })] });
      const out = await dispatchBrowserAction(request({ kind: "navigate", url: `${ORIGIN}/x` }), d);
      expect(out.ok && out.result.refusal_reason).toBe("origin_not_allowed");
      expect(d.navigate).not.toHaveBeenCalled();
    });
  });

  it("produces results the contract accepts on every refusal path", async () => {
    const paths: Array<Partial<DispatchDeps>> = [
      { isRunPaused: async () => true },
      { listTabs: async () => [] },
      { listTabs: async () => [tab({ incognito: true })] },
      { enabledDomains: async () => [] },
    ];
    for (const over of paths) {
      const out = await dispatchBrowserAction(request(READ), deps(over));
      expect(out.ok).toBe(true);
      if (!out.ok) continue;
      expect(browserActionResultSchema.safeParse(out.result).success).toBe(true);
    }
  });
});
