import { describe, expect, it } from "vitest";
import { modelCostUsd, sumUsage } from "../src/pricing.js";

describe("model pricing", () => {
  it("the demo alias always costs $0", () => {
    expect(modelCostUsd({ input_tokens: 10_000, output_tokens: 10_000, model_alias: "demo" })).toBe(
      0,
    );
  });

  it("prices a known alias by input/output token rates", () => {
    // sonnet: $3/Mtok in, $15/Mtok out. 1M in + 1M out = 3 + 15 = 18.
    expect(
      modelCostUsd({
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        model_alias: "claude-sonnet-5",
      }),
    ).toBe(18);
  });

  it("an unknown alias costs 0 (never silently guesses a price)", () => {
    expect(
      modelCostUsd({ input_tokens: 1_000_000, output_tokens: 0, model_alias: "mystery" }),
    ).toBe(0);
  });

  it("sums usage and reports the non-demo alias", () => {
    const total = sumUsage([
      { input_tokens: 100, output_tokens: 50, model_alias: "demo" },
      { input_tokens: 200, output_tokens: 80, model_alias: "claude-sonnet-5" },
    ]);
    expect(total).toEqual({
      input_tokens: 300,
      output_tokens: 130,
      model_alias: "claude-sonnet-5",
    });
  });
});
