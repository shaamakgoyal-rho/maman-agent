import { describe, expect, it } from "vitest";
import { __demoStepsForTests } from "../src/panel/screens/Mother.js";
import type { RecommendationWithState } from "../src/lib/recommendations.js";

describe("Mother demo run preview", () => {
  it("turns observed browser movement into focus, fill, and click steps", () => {
    const item = {
      candidate: {
        canonical_sequence: [
          "chrome_ext:browser:element_focused:textbox:phone:contact",
          "chrome_ext:browser:value_committed:textbox:phone:contact",
          "chrome_ext:browser:press:button:save:contact",
        ],
      },
      recommendation: {
        evidence: { redacted_steps: [] },
      },
    } as unknown as RecommendationWithState;

    expect(__demoStepsForTests(item)).toEqual([
      { label: "Focus phone textbox", detail: "browser / contact", action: "focus" },
      { label: "Fill phone textbox", detail: "browser / contact", action: "fill" },
      { label: "Click save button", detail: "browser / contact", action: "click" },
    ]);
  });

  it("falls back to redacted evidence when no sequence exists", () => {
    const item = {
      candidate: { canonical_sequence: [] },
      recommendation: {
        evidence: {
          redacted_steps: [{ order: 1, app: "Chrome", action: "click Save" }],
        },
      },
    } as unknown as RecommendationWithState;

    expect(__demoStepsForTests(item)).toEqual([
      { label: "click Save", detail: "Chrome", action: "click" },
    ]);
  });
});
