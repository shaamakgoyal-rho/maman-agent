import { describe, expect, it } from "vitest";
import type { ProposedDiff } from "@maman/agent-runtime";
import { browserActionRequestSchema } from "@maman/contracts";
import { executeBrowserPlan, type ExecuteContext, type ExecuteDeps } from "@maman/browser-actuator";
import {
  browserActuationOrigins,
  changesForRecord,
  mintAuthorization,
  previewBrowserPlan,
  primaryRecord,
  runBrowserPlan,
  revertBrowserRun,
} from "../src/lib/browserRun.js";

const ORIGIN = "https://acme.my.salesforce.com";
const NOW = new Date("2026-08-05T12:00:00.000Z");

function diff(changes: ProposedDiff["changes"]): ProposedDiff {
  return {
    summary: {
      input_rows: changes.length,
      confident_matches: changes.length,
      ambiguous_skipped: 0,
      missing: 0,
      change_count: changes.length,
      accounts_affected: new Set(changes.map((c) => c.account_name)).size,
    },
    changes,
  };
}

const NORTHWIND_EMPLOYEES = {
  account_id: "001aaa",
  account_name: "Northwind Traders",
  field: "employee_count" as const,
  old_value: "120",
  new_value: "340",
};
const NORTHWIND_WEBSITE = {
  account_id: "001aaa",
  account_name: "Northwind Traders",
  field: "website" as const,
  old_value: "northwind.example",
  new_value: "www.northwind.example",
};
const ACME_OWNER = {
  account_id: "001bbb",
  account_name: "Acme Corp",
  field: "owner" as const,
  old_value: "Dana",
  new_value: "Sam",
};

describe("mintAuthorization", () => {
  it("produces a token the contract accepts", () => {
    const token = mintAuthorization();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const request = {
      schema_version: 1,
      type: "browser_action_request",
      request_id: "018f0000-0000-7000-8000-000000000001",
      run_id: "018f0000-0000-7000-8000-000000000002",
      step_id: "s1",
      action: { kind: "read_field", target: { role: "textbox", name: "Employees" } },
      authorization: token,
      allowed_origins: [ORIGIN],
      consequential: false,
      issued_at: NOW.toISOString(),
      expires_at: new Date(NOW.getTime() + 30_000).toISOString(),
    };
    expect(browserActionRequestSchema.safeParse(request).success).toBe(true);
  });

  it("does not repeat", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => mintAuthorization()));
    expect(tokens.size).toBe(200);
  });
});

describe("browserActuationOrigins", () => {
  it("keeps the origin and drops the path the user pasted with it", () => {
    expect(
      browserActuationOrigins([" https://acme.my.salesforce.com/lightning/o/Account/list "]),
    ).toEqual(["https://acme.my.salesforce.com"]);
  });

  it("rejects a bare domain, because the scheme must be stated not guessed", () => {
    expect(browserActuationOrigins(["salesforce.com", "acme.my.salesforce.com"])).toEqual([]);
  });

  it("never actuates over plaintext", () => {
    expect(browserActuationOrigins(["http://acme.my.salesforce.com"])).toEqual([]);
  });

  it("yields nothing from an empty list, so a write has nothing to run against", () => {
    expect(browserActuationOrigins([])).toEqual([]);
    expect(browserActuationOrigins(["", "  ", "not a url"])).toEqual([]);
  });

  it("de-duplicates entries that name the same origin", () => {
    expect(
      browserActuationOrigins([
        "https://acme.my.salesforce.com/a",
        "https://acme.my.salesforce.com/b",
      ]),
    ).toEqual(["https://acme.my.salesforce.com"]);
  });

  it("does not let one entry cover a lookalike host", () => {
    const origins = browserActuationOrigins(["https://salesforce.com"]);
    expect(origins).toEqual(["https://salesforce.com"]);
    expect(origins).not.toContain("https://salesforce.com.evil.test");
  });
});

describe("changesForRecord", () => {
  it("keeps the open record's changes and defers the rest", () => {
    const scoped = changesForRecord(
      diff([NORTHWIND_EMPLOYEES, ACME_OWNER, NORTHWIND_WEBSITE]),
      "Northwind Traders",
    );
    expect(scoped.changes.map((c) => c.field_label)).toEqual(["Employees", "Website"]);
    expect(scoped.deferred).toBe(1);
    expect(scoped.deferred_records).toEqual(["Acme Corp"]);
  });

  it("maps internal field keys to the labels the page actually shows", () => {
    const scoped = changesForRecord(diff([ACME_OWNER]), "Acme Corp");
    // "owner" is not what the field is called on screen.
    expect(scoped.changes[0]).toMatchObject({
      field_label: "Account Owner",
      from: "Dana",
      to: "Sam",
    });
  });

  it("defers a field it has no page label for, rather than guessing one", () => {
    const unknown = {
      ...NORTHWIND_EMPLOYEES,
      field: "annual_revenue" as unknown as typeof NORTHWIND_EMPLOYEES.field,
    };
    const scoped = changesForRecord(diff([unknown]), "Northwind Traders");
    expect(scoped.changes).toEqual([]);
    expect(scoped.deferred).toBe(1);
  });

  it("returns nothing for a record that is not in the diff", () => {
    const scoped = changesForRecord(diff([NORTHWIND_EMPLOYEES]), "Somewhere Else");
    expect(scoped.changes).toEqual([]);
    expect(scoped.deferred).toBe(1);
  });
});

describe("previewBrowserPlan", () => {
  it("describes every action, in order, for the record in view", () => {
    const result = previewBrowserPlan(diff([NORTHWIND_EMPLOYEES, ACME_OWNER]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.record).toBe("Northwind Traders");
    expect(result.preview.lines).toEqual([
      'Show "Employees" on Northwind Traders',
      'Set "Employees" on Northwind Traders: "120" → "340"',
      'Read "Employees" on Northwind Traders back',
      'Click "Save"',
      'Confirm "Employees" on Northwind Traders still reads "340"',
    ]);
    expect(result.preview.writes).toBe(2);
    // The user is TOLD what was left alone rather than it silently vanishing.
    expect(result.preview.deferred).toBe(1);
    expect(result.preview.deferred_records).toEqual(["Acme Corp"]);
  });

  it("refuses an empty diff and names why", () => {
    expect(previewBrowserPlan(diff([]))).toEqual({
      ok: false,
      reason: "the diff proposed no changes",
    });
  });

  it("passes a planner refusal through verbatim, naming the change", () => {
    const noop = { ...NORTHWIND_EMPLOYEES, old_value: "340", new_value: "340" };
    const result = previewBrowserPlan(diff([noop]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("Employees");
    expect(result.reason).toContain("340");
  });

  it("reports no plan when every change is on another record", () => {
    // primaryRecord picks the first account, so this can only happen when that
    // record's only field is unmappable.
    const unknown = {
      ...ACME_OWNER,
      field: "annual_revenue" as unknown as typeof ACME_OWNER.field,
    };
    const result = previewBrowserPlan(diff([unknown]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("no changes");
  });
});

describe("primaryRecord", () => {
  it("is the first record the diff mentions, or nothing", () => {
    expect(primaryRecord(diff([ACME_OWNER, NORTHWIND_EMPLOYEES]))).toBe("Acme Corp");
    expect(primaryRecord(diff([]))).toBeNull();
  });
});

/** A browser that does what it is told and echoes the control it addressed. */
function obedientDeps(): ExecuteDeps {
  let n = 0;
  return {
    dispatch: async (request) => {
      const action = request.action;
      const value =
        action.kind === "set_value"
          ? action.value
          : action.kind === "select_option"
            ? action.option
            : "340";
      return {
        schema_version: 1,
        type: "browser_action_result",
        request_id: request.request_id,
        run_id: request.run_id,
        step_id: request.step_id,
        outcome: ["set_value", "select_option", "click_control"].includes(action.kind)
          ? "applied"
          : "observed",
        observed: {
          resolved_name: action.kind === "navigate" ? action.url : action.target.name,
          value_before: "120",
          value_after: value,
          match_count: 1,
          origin: ORIGIN,
        },
        completed_at: NOW.toISOString(),
      };
    },
    mintAuthorization,
    newRequestId: () => `018f0000-0000-7000-8000-0000000000${String((n += 1)).padStart(2, "0")}`,
    now: () => NOW,
  };
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

describe("runBrowserPlan", () => {
  it("applies the plan and records what a revert would put back", async () => {
    const d = diff([NORTHWIND_EMPLOYEES]);
    const preview = previewBrowserPlan(d);
    if (!preview.ok) throw new Error("expected a plan");
    const scoped = changesForRecord(d, preview.preview.record);

    const result = await runBrowserPlan(preview.preview, scoped.changes, ctx(), obedientDeps());
    expect(result.outcome).toMatchObject({
      halted_at: null,
      all_writes_verified: true,
      writes_applied: 2, // the field write and the save click
    });
    // observed_before is what the PAGE held, not what the diff predicted.
    expect(result.revertable).toEqual([
      { change: scoped.changes[0], observed_before: "120", wrote: "340" },
    ]);
  });

  it("records a revertable entry even when the write could not be confirmed", async () => {
    const d = diff([NORTHWIND_EMPLOYEES]);
    const preview = previewBrowserPlan(d);
    if (!preview.ok) throw new Error("expected a plan");
    const scoped = changesForRecord(d, preview.preview.record);

    const deps = obedientDeps();
    const unconfirming: ExecuteDeps = {
      ...deps,
      dispatch: async (request) => {
        const result = (await deps.dispatch(request)) as Record<string, unknown>;
        if (request.action.kind !== "set_value") return result;
        const observed = result["observed"] as Record<string, unknown>;
        return { ...result, observed: { ...observed, value_after: "120" } };
      },
    };
    const result = await runBrowserPlan(preview.preview, scoped.changes, ctx(), unconfirming);
    expect(result.outcome.all_writes_verified).toBe(false);
    // Something DID change the record, so it must remain revertable.
    expect(result.revertable).toHaveLength(1);
  });

  it("has nothing to revert when the write was never issued", async () => {
    const d = diff([NORTHWIND_EMPLOYEES]);
    const preview = previewBrowserPlan(d);
    if (!preview.ok) throw new Error("expected a plan");
    const scoped = changesForRecord(d, preview.preview.record);
    const result = await runBrowserPlan(
      preview.preview,
      scoped.changes,
      ctx({ mode: "shadow" }),
      obedientDeps(),
    );
    expect(result.revertable).toEqual([]);
  });
});

describe("revertBrowserRun", () => {
  it("puts back the value the page held, guarded against a later edit", async () => {
    const d = diff([NORTHWIND_EMPLOYEES]);
    const preview = previewBrowserPlan(d);
    if (!preview.ok) throw new Error("expected a plan");
    const scoped = changesForRecord(d, preview.preview.record);
    const applied = await runBrowserPlan(preview.preview, scoped.changes, ctx(), obedientDeps());

    const sent: unknown[] = [];
    const deps = obedientDeps();
    const recording: ExecuteDeps = {
      ...deps,
      dispatch: async (request) => {
        sent.push(request.action);
        // The revert writes "120" back, so the read-back must report "120".
        const result = (await deps.dispatch(request)) as Record<string, unknown>;
        if (request.action.kind === "read_field") {
          const observed = result["observed"] as Record<string, unknown>;
          return { ...result, observed: { ...observed, value_after: "120" } };
        }
        return result;
      },
    };

    const reverted = await revertBrowserRun(applied.revertable, ctx(), recording);
    expect(reverted.ok).toBe(true);
    if (!reverted.ok) return;
    expect(reverted.outcome.halted_at).toBeNull();
    expect(sent).toContainEqual({
      kind: "set_value",
      target: { role: "textbox", name: "Employees" },
      value: "120",
      expect_current: "340",
    });
  });

  it("refuses to revert a run that applied nothing", async () => {
    const result = await revertBrowserRun([], ctx(), obedientDeps());
    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.reason).toContain("nothing was applied");
  });

  it("is itself gated: a revert without approval is not issued", async () => {
    const revertable = [
      {
        change: {
          record: "Northwind Traders",
          field_label: "Employees",
          from: "120",
          to: "340",
        },
        observed_before: "120",
        wrote: "340",
      },
    ];
    const result = await revertBrowserRun(
      revertable,
      ctx({ approvalGranted: false }),
      obedientDeps(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const set = result.outcome.steps.find((s) => s.step_id === "c0-set")!;
    expect(set).toMatchObject({ status: "not_issued", issue_refusal: "approval_missing" });
  });
});

describe("the browser lane never routes itself", () => {
  it("refuses when the router selected the api lane", async () => {
    const d = diff([NORTHWIND_EMPLOYEES]);
    const preview = previewBrowserPlan(d);
    if (!preview.ok) throw new Error("expected a plan");
    const outcome = await executeBrowserPlan(
      preview.preview.steps,
      ctx({ routedSource: "api" }),
      obedientDeps(),
    );
    expect(outcome.steps[0]).toMatchObject({
      status: "not_issued",
      issue_refusal: "wrong_source",
    });
  });
});
