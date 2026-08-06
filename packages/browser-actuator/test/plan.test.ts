import { describe, expect, it } from "vitest";
import { browserActionSchema } from "@maman/contracts";
import {
  MAX_PLAN_CHANGES,
  planBrowserWrites,
  planRevert,
  summarizePlan,
  type PlannedChange,
} from "../src/index.js";

function change(over: Partial<PlannedChange> = {}): PlannedChange {
  return {
    record: "Northwind Traders",
    field_label: "Employees",
    from: "120",
    to: "340",
    ...over,
  };
}

describe("planBrowserWrites", () => {
  it("plans focus, write, and read-back for one text field", () => {
    const result = planBrowserWrites({ changes: [change()] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.steps.map((s) => s.step_id)).toEqual(["c0-focus", "c0-set", "c0-verify"]);
    expect(result.steps.map((s) => s.write)).toEqual([false, true, false]);
  });

  it("carries the current value on the write, so a stale plan cannot overwrite", () => {
    const result = planBrowserWrites({ changes: [change()] });
    if (!result.ok) throw new Error("expected a plan");
    const set = result.steps.find((s) => s.step_id === "c0-set")!;
    expect(set.action).toEqual({
      kind: "set_value",
      target: { role: "textbox", name: "Employees" },
      value: "340",
      expect_current: "120",
    });
  });

  it("produces preview lines a person can check against the page", () => {
    const result = planBrowserWrites({
      changes: [change()],
      save_control: "Save",
    });
    if (!result.ok) throw new Error("expected a plan");
    const { lines, writes, reads } = summarizePlan(result.steps);
    expect(lines).toEqual([
      'Show "Employees" on Northwind Traders',
      'Set "Employees" on Northwind Traders: "120" → "340"',
      'Read "Employees" on Northwind Traders back',
      'Click "Save"',
      'Confirm "Employees" on Northwind Traders still reads "340"',
    ]);
    expect({ writes, reads }).toEqual({ writes: 2, reads: 3 });
  });

  it("confirms every field AFTER the save, not only before it", () => {
    const result = planBrowserWrites({
      changes: [change(), change({ record: "Acme", field_label: "Website", from: "a", to: "b" })],
      save_control: "Save",
    });
    if (!result.ok) throw new Error("expected a plan");
    const ids = result.steps.map((s) => s.step_id);
    expect(ids.indexOf("save")).toBeLessThan(ids.indexOf("c0-confirm"));
    expect(ids.filter((i) => i.endsWith("-confirm"))).toEqual(["c0-confirm", "c1-confirm"]);
  });

  it("chooses an option for a picklist instead of typing into it", () => {
    const result = planBrowserWrites({
      changes: [
        change({ field_label: "Stage", role: "combobox", from: "Proposal", to: "Closed Won" }),
      ],
    });
    if (!result.ok) throw new Error("expected a plan");
    expect(result.steps.map((s) => s.step_id)).toEqual([
      "c0-focus",
      "c0-before",
      "c0-set",
      "c0-verify",
    ]);
    expect(result.steps.find((s) => s.step_id === "c0-set")!.action).toEqual({
      kind: "select_option",
      target: { role: "combobox", name: "Stage" },
      option: "Closed Won",
    });
  });

  it("targets a repeated label by its stated position", () => {
    const result = planBrowserWrites({ changes: [change({ nth: 3 })] });
    if (!result.ok) throw new Error("expected a plan");
    for (const step of result.steps) {
      expect("target" in step.action && step.action.target.nth).toBe(3);
    }
  });

  it("produces only actions the contract accepts", () => {
    const result = planBrowserWrites({
      changes: [change(), change({ field_label: "Stage", role: "combobox", from: "a", to: "b" })],
      save_control: "Save",
    });
    if (!result.ok) throw new Error("expected a plan");
    for (const step of result.steps) {
      expect(browserActionSchema.safeParse(step.action).success, step.step_id).toBe(true);
    }
  });

  describe("refusals", () => {
    it("refuses an empty diff", () => {
      expect(planBrowserWrites({ changes: [] })).toMatchObject({
        ok: false,
        reason: "no_changes",
      });
    });

    it("refuses more changes than one approval can cover", () => {
      const many = Array.from({ length: MAX_PLAN_CHANGES + 1 }, (_, i) =>
        change({ field_label: `Field ${i}` }),
      );
      expect(planBrowserWrites({ changes: many })).toMatchObject({
        ok: false,
        reason: "too_many_changes",
      });
    });

    it("accepts exactly the maximum", () => {
      const many = Array.from({ length: MAX_PLAN_CHANGES }, (_, i) =>
        change({ field_label: `Field ${i}` }),
      );
      expect(planBrowserWrites({ changes: many }).ok).toBe(true);
    });

    it("refuses a change with no field label, which could not be targeted", () => {
      expect(planBrowserWrites({ changes: [change({ field_label: "   " })] })).toMatchObject({
        ok: false,
        reason: "missing_field_label",
      });
    });

    it("refuses a write that would change nothing", () => {
      expect(planBrowserWrites({ changes: [change({ from: "x", to: "x" })] })).toMatchObject({
        ok: false,
        reason: "no_change_needed",
      });
    });

    it("refuses two changes to the same control, where one would silently win", () => {
      expect(
        planBrowserWrites({ changes: [change(), change({ from: "340", to: "500" })] }),
      ).toMatchObject({ ok: false, reason: "duplicate_target" });
    });

    it("treats the same label at different positions as different controls", () => {
      expect(planBrowserWrites({ changes: [change({ nth: 0 }), change({ nth: 1 })] }).ok).toBe(
        true,
      );
    });

    it("names what it refused, so the user is told which change is the problem", () => {
      const result = planBrowserWrites({ changes: [change({ from: "x", to: "x" })] });
      if (result.ok) throw new Error("expected a refusal");
      expect(result.detail).toContain("Employees");
      expect(result.detail).toContain("Northwind Traders");
    });
  });

  it("omits the save click when there is no save control", () => {
    const result = planBrowserWrites({ changes: [change()], save_control: "  " });
    if (!result.ok) throw new Error("expected a plan");
    expect(result.steps.some((s) => s.step_id === "save")).toBe(false);
  });
});

describe("planRevert", () => {
  it("restores the value the page actually held, not the one the diff predicted", () => {
    // The diff thought the field read "120"; the page really held "200".
    const result = planRevert([{ change: change(), observed_before: "200", wrote: "340" }]);
    if (!result.ok) throw new Error("expected a plan");
    const set = result.steps.find((s) => s.step_id === "c0-set")!;
    expect(set.action).toMatchObject({ value: "200", expect_current: "340" });
  });

  it("refuses if a third party has changed the field since, rather than clobbering", () => {
    // expect_current is what WE wrote, so the executor refuses when it no longer holds.
    const result = planRevert([{ change: change(), observed_before: "120", wrote: "340" }]);
    if (!result.ok) throw new Error("expected a plan");
    expect(result.steps.find((s) => s.step_id === "c0-set")!.action).toMatchObject({
      expect_current: "340",
    });
  });

  it("unwinds in reverse order", () => {
    const result = planRevert([
      { change: change({ field_label: "Employees" }), observed_before: "1", wrote: "2" },
      { change: change({ field_label: "Website" }), observed_before: "a", wrote: "b" },
    ]);
    if (!result.ok) throw new Error("expected a plan");
    expect(result.steps[0]!.preview).toContain("Website");
  });

  it("has nothing to do when no write was applied", () => {
    expect(planRevert([])).toMatchObject({ ok: false, reason: "no_changes" });
  });

  it("skips a field whose prior value was never read", () => {
    expect(
      planRevert([{ change: change(), observed_before: undefined, wrote: "340" }]),
    ).toMatchObject({ ok: false, reason: "no_changes" });
  });

  it("skips a field that already held what was written", () => {
    expect(planRevert([{ change: change(), observed_before: "340", wrote: "340" }])).toMatchObject({
      ok: false,
      reason: "no_changes",
    });
  });
});
