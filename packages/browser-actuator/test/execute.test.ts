import { describe, expect, it, vi } from "vitest";
import type { BrowserActionRequest, BrowserActionResult } from "@maman/contracts";
import { browserActionRequestSchema } from "@maman/contracts";
import {
  confirmedChanges,
  executeBrowserPlan,
  planBrowserWrites,
  REQUEST_WINDOW_MS,
  type ExecuteContext,
  type ExecuteDeps,
  type PlanStep,
} from "../src/index.js";

const ORIGIN = "https://acme.my.salesforce.com";
const NOW = new Date("2026-08-05T12:00:00.000Z");

function plan(save?: string): PlanStep[] {
  const result = planBrowserWrites({
    changes: [{ record: "Northwind", field_label: "Employees", from: "120", to: "340" }],
    ...(save === undefined ? {} : { save_control: save }),
  });
  if (!result.ok) throw new Error("fixture plan should be valid");
  return result.steps;
}

function ctx(over: Partial<ExecuteContext> = {}): ExecuteContext {
  return {
    runId: "018f0000-0000-7000-8000-000000000002",
    routedSource: "browser_extension",
    mode: "supervised",
    allowSupervisedBrowserWrites: true,
    approvalGranted: true,
    userPresent: true,
    allowedOrigins: [ORIGIN],
    ...over,
  };
}

/**
 * Answers as though the page did exactly what was asked.
 *
 * `resolved_name` echoes the control that was actually addressed. Getting this
 * wrong the first time made two tests fail — correctly: a Save click whose
 * resolved name was "Employees" is a click that landed somewhere else, which the
 * executor is supposed to treat as unverified.
 */
function happyDispatch(): (r: BrowserActionRequest) => Promise<BrowserActionResult> {
  return async (request) => {
    const action = request.action;
    const value =
      action.kind === "set_value"
        ? action.value
        : action.kind === "select_option"
          ? action.option
          : "340";
    const resolvedName =
      action.kind === "navigate"
        ? action.url
        : action.kind === "list_controls"
          ? "" // a surface listing resolves no single control
          : (action.target.name satisfies string);
    return {
      schema_version: 1,
      type: "browser_action_result",
      request_id: request.request_id,
      run_id: request.run_id,
      step_id: request.step_id,
      outcome: "applied",
      observed: {
        resolved_name: resolvedName,
        value_before: "120",
        value_after: value,
        match_count: 1,
        origin: ORIGIN,
      },
      completed_at: NOW.toISOString(),
    } as BrowserActionResult;
  };
}

function deps(
  dispatch: (r: BrowserActionRequest) => Promise<unknown>,
  over: Partial<ExecuteDeps> = {},
): ExecuteDeps {
  let n = 0;
  let t = 0;
  return {
    dispatch: vi.fn(dispatch),
    mintAuthorization: () => `tok${(n += 1)}`.padEnd(40, "0"),
    newRequestId: () => `018f0000-0000-7000-8000-0000000000${String((t += 1)).padStart(2, "0")}`,
    now: () => NOW,
    ...over,
  };
}

/** A read is "observed", not "applied" — the happy dispatch above is too generous. */
function correctDispatch(): (r: BrowserActionRequest) => Promise<BrowserActionResult> {
  const inner = happyDispatch();
  return async (request) => {
    const result = await inner(request);
    const isWrite = ["set_value", "select_option", "click_control"].includes(request.action.kind);
    return { ...result, outcome: isWrite ? "applied" : "observed" } as BrowserActionResult;
  };
}

describe("executeBrowserPlan — the happy path", () => {
  it("runs every step and reports the write verified", async () => {
    const d = deps(correctDispatch());
    const outcome = await executeBrowserPlan(plan(), ctx(), d);
    expect(outcome.steps.map((s) => s.status)).toEqual(["observed", "applied", "observed"]);
    expect(outcome).toMatchObject({
      halted_at: null,
      halted_because: null,
      writes_applied: 1,
      all_writes_verified: true,
    });
  });

  it("sends requests the contract accepts, one fresh token each", async () => {
    const sent: BrowserActionRequest[] = [];
    const d = deps(async (r) => {
      sent.push(r);
      return correctDispatch()(r);
    });
    await executeBrowserPlan(plan("Save"), ctx(), d);
    for (const request of sent) {
      expect(browserActionRequestSchema.safeParse(request).success).toBe(true);
    }
    const tokens = sent.map((r) => r.authorization);
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it("marks only writes consequential", async () => {
    const sent: BrowserActionRequest[] = [];
    const d = deps(async (r) => {
      sent.push(r);
      return correctDispatch()(r);
    });
    await executeBrowserPlan(plan("Save"), ctx(), d);
    for (const request of sent) {
      const isWrite = ["set_value", "select_option", "click_control"].includes(request.action.kind);
      expect(request.consequential, request.step_id).toBe(isWrite);
    }
  });

  it("bounds each request's validity window", async () => {
    const sent: BrowserActionRequest[] = [];
    const d = deps(async (r) => {
      sent.push(r);
      return correctDispatch()(r);
    });
    await executeBrowserPlan(plan(), ctx(), d);
    for (const request of sent) {
      expect(Date.parse(request.expires_at) - Date.parse(request.issued_at)).toBe(
        REQUEST_WINDOW_MS,
      );
    }
  });

  it("treats a save click as applied, since a button reads nothing back", async () => {
    const d = deps(correctDispatch());
    const outcome = await executeBrowserPlan(plan("Save"), ctx(), d);
    expect(outcome.steps.find((s) => s.step_id === "save")!.status).toBe("applied");
    expect(outcome.halted_at).toBeNull();
    expect(outcome.writes_applied).toBe(2);
  });
});

describe("executeBrowserPlan — it stops rather than carrying on", () => {
  it("halts on a refusal and skips every later step", async () => {
    const d = deps(async (request) => {
      if (request.action.kind === "set_value") {
        return {
          schema_version: 1,
          type: "browser_action_result",
          request_id: request.request_id,
          run_id: request.run_id,
          step_id: request.step_id,
          outcome: "refused",
          refusal_reason: "precondition_failed",
          completed_at: NOW.toISOString(),
        };
      }
      return correctDispatch()(request);
    });
    const outcome = await executeBrowserPlan(plan("Save"), ctx(), d);
    expect(outcome.halted_at).toBe("c0-set");
    expect(outcome.halted_because).toContain("precondition_failed");
    expect(outcome.steps.filter((s) => s.status === "skipped").map((s) => s.step_id)).toEqual([
      "c0-verify",
      "save",
      "c0-confirm",
    ]);
    // Crucially: Save was never clicked.
    expect(outcome.writes_applied).toBe(0);
    expect(outcome.all_writes_verified).toBe(false);
  });

  it("never retries a dispatch that threw, because the write may have landed", async () => {
    let calls = 0;
    const d = deps(async (request) => {
      if (request.action.kind === "set_value") {
        calls += 1;
        throw new Error("the browser did not answer in time");
      }
      return correctDispatch()(request);
    });
    const outcome = await executeBrowserPlan(plan("Save"), ctx(), d);
    expect(calls).toBe(1);
    expect(outcome.halted_at).toBe("c0-set");
    expect(outcome.halted_because).toContain("did not answer in time");
  });

  it("halts when the write does not read back, instead of stacking more changes", async () => {
    const d = deps(async (request) => {
      const result = await correctDispatch()(request);
      if (request.action.kind !== "set_value") return result;
      // Applied, but the page still shows the old value.
      return {
        ...result,
        observed: { ...result.observed!, value_after: "120" },
      } as BrowserActionResult;
    });
    const outcome = await executeBrowserPlan(plan("Save"), ctx(), d);
    expect(outcome.steps.find((s) => s.step_id === "c0-set")!.status).toBe("unverified");
    expect(outcome.halted_at).toBe("c0-set");
    expect(outcome.all_writes_verified).toBe(false);
    // Counted as applied: something DID change the record, and pretending otherwise
    // would leave the user with no reason to check it.
    expect(outcome.writes_applied).toBe(1);
    expect(outcome.steps.find((s) => s.step_id === "save")!.status).toBe("skipped");
  });

  it("halts on an answer that does not match the contract", async () => {
    const d = deps(async () => ({ outcome: "definitely_fine" }));
    const outcome = await executeBrowserPlan(plan(), ctx(), d);
    expect(outcome.steps[0]!.status).toBe("failed");
    expect(outcome.halted_because).toContain("did not match the contract");
  });

  it("halts a read step's refusal without claiming a write went wrong", async () => {
    const d = deps(async (request) => ({
      schema_version: 1,
      type: "browser_action_result",
      request_id: request.request_id,
      run_id: request.run_id,
      step_id: request.step_id,
      outcome: "refused",
      refusal_reason: "ambiguous_match",
      observed: { resolved_name: "", match_count: 3, origin: ORIGIN },
      completed_at: NOW.toISOString(),
    }));
    const outcome = await executeBrowserPlan(plan(), ctx(), d);
    expect(outcome.steps[0]).toMatchObject({
      status: "refused",
      refusal_reason: "ambiguous_match",
      observed: { match_count: 3 },
    });
    // No write was attempted, so nothing is unverified.
    expect(outcome.all_writes_verified).toBe(true);
    expect(outcome.writes_applied).toBe(0);
  });

  it("treats a write with nothing read back as unverified, not as applied-and-fine", async () => {
    const d = deps(async (request) => ({
      schema_version: 1,
      type: "browser_action_result",
      request_id: request.request_id,
      run_id: request.run_id,
      step_id: request.step_id,
      outcome: request.action.kind === "set_value" ? "applied" : "observed",
      // No `observed` at all — the executor claimed success and showed nothing.
      completed_at: NOW.toISOString(),
    }));
    const outcome = await executeBrowserPlan(plan(), ctx(), d);
    expect(outcome.steps.find((s) => s.step_id === "c0-set")!.status).toBe("unverified");
    expect(outcome.all_writes_verified).toBe(false);
    expect(outcome.halted_because).toContain("no_observation");
  });

  it("halts on a failure the browser did not explain", async () => {
    const d = deps(async (request) => ({
      schema_version: 1,
      type: "browser_action_result",
      request_id: request.request_id,
      run_id: request.run_id,
      step_id: request.step_id,
      outcome: "failed",
      completed_at: NOW.toISOString(),
    }));
    const outcome = await executeBrowserPlan(plan(), ctx(), d);
    expect(outcome.steps[0]!.protocol_error).toBeUndefined();
    expect(outcome.halted_because).toBe("the browser could not perform the action");
  });

  it("survives a dispatch that threw something that is not an Error", async () => {
    const d = deps(async () => {
      throw "a string, as some transports do";
    });
    const outcome = await executeBrowserPlan(plan(), ctx(), d);
    expect(outcome.steps[0]).toMatchObject({ status: "failed", protocol_error: "dispatch failed" });
    expect(outcome.halted_because).toBe("dispatch failed");
  });

  it("applies and verifies a picklist change", async () => {
    const combo = planBrowserWrites({
      changes: [
        {
          record: "Northwind",
          field_label: "Stage",
          role: "combobox",
          from: "Proposal",
          to: "Closed Won",
        },
      ],
    });
    if (!combo.ok) throw new Error("expected a plan");
    const outcome = await executeBrowserPlan(combo.steps, ctx(), deps(correctDispatch()));
    expect(outcome.steps.map((s) => s.status)).toEqual([
      "observed",
      "observed",
      "applied",
      "observed",
    ]);
    expect(outcome).toMatchObject({ halted_at: null, all_writes_verified: true });
  });

  it("halts on a reported failure and records what the browser said", async () => {
    const d = deps(async (request) => ({
      schema_version: 1,
      type: "browser_action_result",
      request_id: request.request_id,
      run_id: request.run_id,
      step_id: request.step_id,
      outcome: "failed",
      failure: "the page threw while applying the action",
      completed_at: NOW.toISOString(),
    }));
    const outcome = await executeBrowserPlan(plan(), ctx(), d);
    expect(outcome.steps[0]!.protocol_error).toBe("the page threw while applying the action");
    expect(outcome.halted_at).toBe("c0-focus");
  });
});

describe("executeBrowserPlan — the on-device gate runs before the wire", () => {
  it("sends nothing at all from a shadow run's write", async () => {
    const d = deps(correctDispatch());
    const outcome = await executeBrowserPlan(plan("Save"), ctx({ mode: "shadow" }), d);
    // The read-only steps still run; the write is never sent.
    const set = outcome.steps.find((s) => s.step_id === "c0-set")!;
    expect(set.status).toBe("not_issued");
    expect(set.issue_refusal).toBe("shadow_run_never_writes");
    expect(outcome.halted_at).toBe("c0-set");
    const dispatched = (d.dispatch as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => (c[0] as BrowserActionRequest).step_id,
    );
    expect(dispatched).toEqual(["c0-focus"]);
  });

  it("refuses without policy, without approval, and without a user present", async () => {
    for (const [over, reason] of [
      [{ allowSupervisedBrowserWrites: false }, "policy_forbids_browser_writes"],
      [{ approvalGranted: false }, "approval_missing"],
      [{ userPresent: false }, "user_absent"],
    ] as const) {
      const outcome = await executeBrowserPlan(plan(), ctx(over), deps(correctDispatch()));
      const set = outcome.steps.find((s) => s.step_id === "c0-set")!;
      expect(set.issue_refusal, JSON.stringify(over)).toBe(reason);
      expect(outcome.all_writes_verified).toBe(false);
    }
  });

  it("refuses the whole plan when the router chose another lane", async () => {
    const d = deps(correctDispatch());
    const outcome = await executeBrowserPlan(plan(), ctx({ routedSource: "api" }), d);
    expect(outcome.steps[0]).toMatchObject({ status: "not_issued", issue_refusal: "wrong_source" });
    expect(d.dispatch).not.toHaveBeenCalled();
  });

  it("refuses a reused token, so the same request can never run twice", async () => {
    // A minting function that forgets to be unique is a bug this must survive.
    const d = deps(correctDispatch(), { mintAuthorization: () => "same".padEnd(40, "0") });
    const outcome = await executeBrowserPlan(plan(), ctx(), d);
    expect(outcome.steps[0]!.status).toBe("observed");
    expect(outcome.steps[1]).toMatchObject({
      status: "not_issued",
      issue_refusal: "authorization_reused",
    });
  });
});

describe("confirmedChanges", () => {
  it("reports a change whose value survived the save", async () => {
    const outcome = await executeBrowserPlan(plan("Save"), ctx(), deps(correctDispatch()));
    expect(confirmedChanges(outcome, ["340"])).toEqual([{ change_index: 0, confirmed: true }]);
  });

  it("reports a change that did not survive the save", async () => {
    const d = deps(async (request) => {
      const result = await correctDispatch()(request);
      if (request.step_id !== "c0-confirm") return result;
      return { ...result, observed: { ...result.observed!, value_after: "120" } };
    });
    const outcome = await executeBrowserPlan(plan("Save"), ctx(), d);
    expect(confirmedChanges(outcome, ["340"])).toEqual([{ change_index: 0, confirmed: false }]);
  });

  it("does not report confirmed when the caller gave no expected value to compare", async () => {
    const outcome = await executeBrowserPlan(plan("Save"), ctx(), deps(correctDispatch()));
    expect(confirmedChanges(outcome, [])).toEqual([{ change_index: 0, confirmed: false }]);
  });

  it("reports nothing confirmed when the plan never reached the save", async () => {
    const d = deps(async (request) => {
      if (request.action.kind === "click_control") throw new Error("gone");
      return correctDispatch()(request);
    });
    const outcome = await executeBrowserPlan(plan("Save"), ctx(), d);
    expect(confirmedChanges(outcome, ["340"])).toEqual([{ change_index: 0, confirmed: false }]);
  });
});
