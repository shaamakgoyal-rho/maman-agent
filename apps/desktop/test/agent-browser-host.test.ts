import { describe, expect, it, vi, beforeEach } from "vitest";
import { ownWindowDispatch, parseActionResult } from "@maman/browser-actuator";
import type { BrowserAction, BrowserActionRequest } from "@maman/contracts";

/**
 * The desktop's binding of the own-window transport to real Tauri commands.
 *
 * The transport's own rules are proven in `@maman/browser-actuator`. What is
 * proven HERE is that the binding does not quietly break them: that the
 * allowlist travels with every action, that the web preview fails loudly rather
 * than pretending, and that the pure core still refuses an origin drift when the
 * answers come from these commands rather than a stub.
 */

const invoked: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
let isTauriValue = true;
const commandResults = new Map<string, unknown>();

vi.mock("../src/lib/bridge.js", () => ({
  isTauri: () => isTauriValue,
  invokeCommand: async (cmd: string, args?: Record<string, unknown>) => {
    invoked.push({ cmd, ...(args ? { args } : {}) });
    if (commandResults.has(cmd)) return commandResults.get(cmd);
    return undefined;
  },
  emitAppEvent: async () => undefined,
}));

const { tauriAgentBrowserHost, closeAgentBrowser } = await import("../src/lib/agentBrowser.js");

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
  } as unknown as BrowserActionRequest;
}

const READ: BrowserAction = { kind: "read_field", target: { role: "textbox", name: "Phone" } };

beforeEach(() => {
  invoked.length = 0;
  isTauriValue = true;
  commandResults.clear();
  commandResults.set("agent_browser_origin", ORIGIN);
});

describe("the allowlist travels with every action", () => {
  it("sends the current origins on each navigate, not a cached set", async () => {
    // Revoking a site must take effect on the NEXT action, not the next
    // restart, so the list is passed per call rather than held in Rust.
    const first = tauriAgentBrowserHost([ORIGIN, "https://b.example"]);
    await first.navigate(`${ORIGIN}/record/1`);
    const second = tauriAgentBrowserHost([ORIGIN]);
    await second.navigate(`${ORIGIN}/record/2`);

    const opens = invoked.filter((i) => i.cmd === "agent_browser_open");
    expect(opens).toHaveLength(2);
    expect(opens[0]!.args!.allowedOrigins).toEqual([ORIGIN, "https://b.example"]);
    expect(opens[1]!.args!.allowedOrigins).toEqual([ORIGIN]);
  });

  it("copies the list so a later mutation cannot widen a sent request", async () => {
    const origins = [ORIGIN];
    const host = tauriAgentBrowserHost(origins);
    await host.navigate(`${ORIGIN}/x`);
    origins.push("https://sneaky.example");
    const sent = invoked.find((i) => i.cmd === "agent_browser_open")!.args!.allowedOrigins;
    expect(sent).toEqual([ORIGIN]);
  });
});

describe("the web preview fails loudly", () => {
  it("throws instead of hanging or reporting a silent no-change", async () => {
    isTauriValue = false;
    const host = tauriAgentBrowserHost([ORIGIN]);
    await expect(host.evaluate("1")).rejects.toThrow(/needs the desktop app/);
    await expect(host.currentOrigin()).rejects.toThrow(/needs the desktop app/);
    await expect(host.navigate(`${ORIGIN}/x`)).rejects.toThrow(/needs the desktop app/);
    // And nothing was dispatched to a window that does not exist.
    expect(invoked).toEqual([]);
  });

  it("closing is a no-op in the preview rather than an error", async () => {
    isTauriValue = false;
    await expect(closeAgentBrowser()).resolves.toBeUndefined();
  });
});

describe("the origin comes from the host command", () => {
  it("reports null when nothing is loaded", async () => {
    commandResults.set("agent_browser_origin", null);
    const host = tauriAgentBrowserHost([ORIGIN]);
    expect(await host.currentOrigin()).toBeNull();
  });

  it("normalises an undefined answer to null", async () => {
    commandResults.delete("agent_browser_origin");
    const host = tauriAgentBrowserHost([ORIGIN]);
    expect(await host.currentOrigin()).toBeNull();
  });
});

describe("the pure core's rules survive the real binding", () => {
  it("refuses to evaluate when the window drifted to another origin", async () => {
    commandResults.set("agent_browser_origin", "https://evil.example");
    const dispatch = ownWindowDispatch(tauriAgentBrowserHost([ORIGIN]));
    await expect(dispatch(request(READ))).rejects.toThrow(/origin_mismatch/);
    // The decisive part: no expression ever reached the drifted page.
    expect(invoked.some((i) => i.cmd === "agent_browser_evaluate")).toBe(false);
  });

  it("refuses when no window is open", async () => {
    commandResults.set("agent_browser_origin", null);
    const dispatch = ownWindowDispatch(tauriAgentBrowserHost([ORIGIN]));
    await expect(dispatch(request(READ))).rejects.toThrow(/no_window/);
  });

  it("carries a real page answer through to a validated result", async () => {
    commandResults.set(
      "agent_browser_evaluate",
      JSON.stringify({
        request_id: REQ_ID,
        outcome: "observed",
        observed: { value_after: "555-0100", accessible_name: "Phone", match_count: 1 },
      }),
    );
    const dispatch = ownWindowDispatch(tauriAgentBrowserHost([ORIGIN]));
    const result = parseActionResult(await dispatch(request(READ)));
    expect(result.outcome).toBe("observed");
    expect(result.observed?.value_after).toBe("555-0100");
    // The origin on the record is the host's, never the page's.
    expect(result.observed?.origin).toBe(ORIGIN);
  });

  it("turns a forged request id from the page into a failure", async () => {
    commandResults.set(
      "agent_browser_evaluate",
      JSON.stringify({ request_id: "not-the-one-we-sent", outcome: "applied" }),
    );
    const dispatch = ownWindowDispatch(tauriAgentBrowserHost([ORIGIN]));
    const result = parseActionResult(await dispatch(request(READ)));
    expect(result.outcome).toBe("failed");
  });

  it("performs a navigation through the host, never as page script", async () => {
    const dispatch = ownWindowDispatch(tauriAgentBrowserHost([ORIGIN]));
    const result = parseActionResult(
      await dispatch(request({ kind: "navigate", url: `${ORIGIN}/record/1` })),
    );
    expect(result.outcome).toBe("observed");
    expect(invoked.some((i) => i.cmd === "agent_browser_open")).toBe(true);
    expect(invoked.some((i) => i.cmd === "agent_browser_evaluate")).toBe(false);
  });
});
