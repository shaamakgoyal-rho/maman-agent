import { describe, expect, it } from "vitest";
import { explainWorkflowSteps } from "../src/explain.js";

/**
 * The precision contract for the suggestion card: every observed step gets an
 * exact, role-aware description AND an exact automation verdict. The first
 * fixture is the live pattern from the first real device (pattern 019fc4d0…,
 * replay 21/21) — the one whose card previously read only "Repeated 3-step
 * workflow in the browser".
 */

const LIVE_BROWSER_SEQUENCE = [
  "macos_ax:browser:element_focused:AXGroup:-:-",
  "macos_ax:browser:value_committed:AXStaticText:-:-",
  "macos_ax:browser:value_committed:AXTextField:-:-",
];

describe("explainWorkflowSteps", () => {
  it("explains the live browser pattern step by step, role-aware", () => {
    const explanation = explainWorkflowSteps(LIVE_BROWSER_SEQUENCE);
    expect(explanation.steps.map((s) => s.observed)).toEqual([
      "you focus a section of the page",
      // AXStaticText is not user-editable: the page updated, the user did not type.
      "a block of text updates",
      "you change the value of a text field",
    ]);
    expect(explanation.steps.every((s) => s.app === "the browser")).toBe(true);
  });

  it("names the exact automation chain for a browser field change", () => {
    const explanation = explainWorkflowSteps(LIVE_BROWSER_SEQUENCE);
    const fieldStep = explanation.steps[2]!;
    if (fieldStep.automation.kind !== "automated") throw new Error("expected automated");
    expect(fieldStep.automation.steps).toEqual([
      {
        capability_id: "browser.propose_form_fill",
        action: "Propose a form fill",
        mode: "propose_write",
        needs_approval: false,
        reversible: true,
      },
      {
        capability_id: "browser.supervised_form_fill",
        action: "Supervised form fill",
        mode: "write",
        needs_approval: true, // writes are ALWAYS approval-gated
        reversible: false, // and this one is honestly irreversible
      },
    ]);
    expect(explanation.has_writes).toBe(true);
    expect(explanation.read_only).toBe(false);
  });

  it("marks app and window switches as context, not manual work", () => {
    const explanation = explainWorkflowSteps([
      "macos_ax:browser:app_activated:-:-:-",
      "macos_ax:browser:window_focused:AXWindow:-:-",
    ]);
    for (const step of explanation.steps) {
      expect(step.automation.kind).toBe("context");
    }
    expect(explanation.work_step_count).toBe(0);
    expect(explanation.automated_count).toBe(0);
  });

  it("says plainly when real work has no safe capability", () => {
    // `other` = a native app we could not identify: honest manual verdict.
    const explanation = explainWorkflowSteps(["macos_ax:other:value_committed:AXTextField:-:-"]);
    const step = explanation.steps[0]!;
    expect(step.automation.kind).toBe("manual");
    expect(step.app).toBe("an app I couldn't identify");
    expect(explanation.work_step_count).toBe(1);
    expect(explanation.automated_count).toBe(0);
  });

  it("collapses consecutive identical steps with a repeat count", () => {
    const explanation = explainWorkflowSteps([
      "macos_ax:browser:value_committed:AXTextField:-:-",
      "macos_ax:browser:value_committed:AXTextField:-:-",
      "macos_ax:browser:value_committed:AXTextField:-:-",
      "macos_ax:browser:element_focused:AXButton:-:-",
    ]);
    expect(explanation.steps).toHaveLength(2);
    expect(explanation.steps[0]!.repeats).toBe(3);
    expect(explanation.steps[1]!.repeats).toBe(1);
    // Non-consecutive repeats are NOT merged — order is the evidence.
    const alternating = explainWorkflowSteps([
      "macos_ax:browser:value_committed:AXTextField:-:-",
      "macos_ax:browser:element_focused:AXButton:-:-",
      "macos_ax:browser:value_committed:AXTextField:-:-",
    ]);
    expect(alternating.steps).toHaveLength(3);
  });

  it("reports read-only when every automated step only reads", () => {
    const explanation = explainWorkflowSteps([
      "macos_ax:browser:element_focused:AXGroup:-:-", // extract_structured_fields (read)
    ]);
    expect(explanation.read_only).toBe(true);
    expect(explanation.has_writes).toBe(false);
  });

  it("carries the semantic type into the observed phrase when present", () => {
    const explanation = explainWorkflowSteps([
      "chrome:crm:value_committed:AXTextField:email_address:contact",
    ]);
    expect(explanation.steps[0]!.observed).toBe(
      "you change the value of a text field (email address)",
    );
  });

  it("treats a Chrome-relay cell edit as a USER edit, not a page update", () => {
    // The relay emits lowercase ARIA-style roles; editing a spreadsheet cell
    // is the user's own change and must read that way.
    const explanation = explainWorkflowSteps([
      "chrome:spreadsheet:value_committed:cell:company_domain:account",
    ]);
    expect(explanation.steps[0]!.observed).toBe(
      "you change the value of a spreadsheet cell (company domain)",
    );
  });

  it("humanizes unknown AX roles instead of leaking AX jargon", () => {
    const explanation = explainWorkflowSteps([
      "macos_ax:browser:element_focused:AXDisclosureTriangle:-:-",
    ]);
    expect(explanation.steps[0]!.observed).toBe("you focus a disclosure triangle");
    expect(explanation.steps[0]!.observed).not.toContain("AX");
  });
});
