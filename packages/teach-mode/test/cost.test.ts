import { describe, expect, it } from "vitest";
import {
  describeCostCeiling,
  estimateSessionCost,
  imageTokens,
  IMAGE_PIXELS_PER_TOKEN,
  sessionSpend,
  SHIPPED_VISION_DEFAULTS,
  type SessionEstimateInput,
  type TokenPrice,
} from "../src/index.js";

const SONNET: TokenPrice = { input_per_mtok_usd: 3, output_per_mtok_usd: 15 };
const HAIKU: TokenPrice = { input_per_mtok_usd: 1, output_per_mtok_usd: 5 };
const FREE: TokenPrice = { input_per_mtok_usd: 0, output_per_mtok_usd: 0 };

// `SHIPPED_VISION_DEFAULTS` is `as const`, so its fields have LITERAL types. The
// override must be typed against the input, or no test can vary frame size — which
// typecheck caught even though the tests themselves were passing.
function estimate(maxSeconds: number, price: TokenPrice, over: Partial<SessionEstimateInput> = {}) {
  return estimateSessionCost({ ...SHIPPED_VISION_DEFAULTS, maxSeconds, price, ...over });
}

describe("imageTokens", () => {
  it("uses the documented pixels-per-token rate", () => {
    expect(IMAGE_PIXELS_PER_TOKEN).toBe(750);
    expect(imageTokens(750, 1)).toBe(1);
    // The shipped transport cap, which is the number the whole estimate turns on.
    expect(imageTokens(1400, 933)).toBe(1742);
  });

  it("rounds up, because a partial token is still billed", () => {
    expect(imageTokens(751, 1)).toBe(2);
  });

  it("costs nothing for a degenerate frame instead of returning NaN", () => {
    expect(imageTokens(0, 900)).toBe(0);
    expect(imageTokens(-1400, 933)).toBe(0);
  });
});

describe("estimateSessionCost", () => {
  it("is a ceiling: every tick sends a frame", () => {
    const fiveMinutes = estimate(300, SONNET);
    expect(fiveMinutes.maxFrames).toBe(120); // 300s / 2.5s
    const fifteen = estimate(900, SONNET);
    expect(fifteen.maxFrames).toBe(360);
  });

  it("prices a 15-minute session on the shipped defaults at single-digit dollars", () => {
    // Not an assertion about a good price — an assertion that the number is KNOWN.
    // "vision is not cheap" is not something a user can act on; $3 for a quarter
    // hour is.
    const fifteen = estimate(900, SONNET);
    expect(fifteen.maxCostUsd).toBeGreaterThan(2);
    expect(fifteen.maxCostUsd).toBeLessThan(5);
    // A cheaper model is roughly a third of it.
    expect(estimate(900, HAIKU).maxCostUsd).toBeLessThan(fifteen.maxCostUsd / 2.5);
  });

  it("names the image as the dominant cost, which is what makes frame size the lever", () => {
    const fifteen = estimate(900, SONNET);
    expect(fifteen.imageShareOfInput).toBeGreaterThan(0.75);
    // Halving the frame's longest edge roughly quarters its pixels, so a smaller
    // frame beats a shorter prompt by a wide margin.
    const smaller = estimate(900, SONNET, { frameWidth: 700, frameHeight: 467 });
    expect(smaller.maxCostUsd).toBeLessThan(fifteen.maxCostUsd * 0.6);
  });

  it("models the reply at its measured size, NOT at the max_tokens cap", () => {
    // Modelling output at the 1024-token cap overstated a 15-minute session by
    // roughly 8x on the first attempt, which would have made the feature look
    // unaffordable when it is not.
    const measured = estimate(900, SONNET);
    const atTheCap = estimate(900, SONNET, { expectedOutputTokens: 1024 });
    expect(atTheCap.maxCostUsd).toBeGreaterThan(measured.maxCostUsd * 2);
  });

  it("scales linearly with session length", () => {
    const five = estimate(300, SONNET);
    const fifteen = estimate(900, SONNET);
    expect(fifteen.maxCostUsd).toBeCloseTo(five.maxCostUsd * 3, 4);
    expect(fifteen.costPerMinuteUsd).toBeCloseTo(five.costPerMinuteUsd, 4);
  });

  it("costs nothing when nothing is priced, rather than reporting a fake number", () => {
    const free = estimate(900, FREE);
    expect(free.maxCostUsd).toBe(0);
    expect(free.costPerMinuteUsd).toBe(0);
    // The tokens are still counted — only the money is zero.
    expect(free.inputTokens).toBeGreaterThan(0);
  });

  it("handles a zero-length session without dividing by zero", () => {
    const none = estimate(0, SONNET);
    expect(none).toMatchObject({
      maxFrames: 0,
      inputTokens: 0,
      maxCostUsd: 0,
      costPerMinuteUsd: 0,
    });
  });
});

describe("SHIPPED_VISION_DEFAULTS matches what actually ships", () => {
  it("uses the observer's real cadence and transport cap", () => {
    // These mirror TeachCapture.swift. If the observer changes and this does not,
    // the number shown to the user drifts from the truth.
    expect(SHIPPED_VISION_DEFAULTS.cadenceSeconds).toBe(2.5);
    expect(SHIPPED_VISION_DEFAULTS.frameWidth).toBe(1400);
  });

  it("uses a measured prompt and reply size, not round numbers", () => {
    // Both were measured from the real prompt in vision.rs and a real two-action
    // reply. A suspiciously round value here means someone guessed.
    expect(SHIPPED_VISION_DEFAULTS.systemPromptTokens).toBe(445);
    expect(SHIPPED_VISION_DEFAULTS.expectedOutputTokens).toBe(128);
  });
});

describe("sessionSpend", () => {
  it("reports what was actually consumed, so the estimate can be checked", () => {
    const spend = sessionSpend(
      [
        { inputTokens: 2187, outputTokens: 128 },
        { inputTokens: 2187, outputTokens: 96 },
      ],
      SONNET,
    );
    expect(spend.frames).toBe(2);
    expect(spend.inputTokens).toBe(4374);
    expect(spend.outputTokens).toBe(224);
    expect(spend.costUsd).toBeCloseTo((4374 / 1e6) * 3 + (224 / 1e6) * 15, 6);
  });

  it("is zero for a session that sent nothing", () => {
    expect(sessionSpend([], SONNET)).toEqual({
      frames: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
  });

  it("ignores a negative count rather than crediting it back", () => {
    // A malformed usage report must not make a session look cheaper than it was.
    const spend = sessionSpend([{ inputTokens: -5000, outputTokens: 128 }], SONNET);
    expect(spend.inputTokens).toBe(0);
    expect(spend.costUsd).toBeGreaterThan(0);
  });

  it("stays under the ceiling for a session that ran its full length", () => {
    // The property the ceiling exists to have: real spend lands under it, because
    // identical frames are dropped before egress and refusals cost nothing.
    const ceiling = estimate(300, SONNET);
    const real = sessionSpend(
      Array.from({ length: 40 }, () => ({ inputTokens: 2187, outputTokens: 128 })),
      SONNET,
    );
    expect(real.costUsd).toBeLessThan(ceiling.maxCostUsd);
  });
});

describe("describeCostCeiling", () => {
  it("says it is a ceiling, not a price", () => {
    const text = describeCostCeiling(estimate(900, SONNET));
    expect(text).toMatch(/up to about \$\d+\.\d\d/);
    expect(text).toContain("if every one of 360 moments");
  });

  it("never renders a real cost as $0.00", () => {
    const tiny = estimate(300, { input_per_mtok_usd: 0.001, output_per_mtok_usd: 0.001 });
    expect(tiny.maxCostUsd).toBeGreaterThan(0);
    expect(describeCostCeiling(tiny)).toContain("under $0.01");
  });

  it("says plainly when nothing is configured to run", () => {
    expect(describeCostCeiling(estimate(900, FREE))).toContain("nothing is configured to run");
  });
});
