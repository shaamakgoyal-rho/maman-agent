/**
 * What a Teach Mode session costs, derived rather than guessed.
 *
 * This exists because "vision per frame is not cheap" is not something a user can
 * act on. A session that might cost two dollars and one that might cost fifty are
 * different products, and the difference is arithmetic — so it is computed, shown
 * before the user starts, and tracked against reality while a session runs.
 *
 * The estimate is a CEILING, not a forecast. It assumes every tick produces a
 * frame that is actually sent, which is the worst case: identical consecutive
 * frames are dropped by digest before egress, and every gate refusal costs
 * nothing. Real sessions land under it, and `sessionSpend` reports what was
 * actually consumed so the two can be compared instead of trusted.
 */

/** USD per million tokens, matching `@maman/model-provider`'s pricing shape. */
export type TokenPrice = { input_per_mtok_usd: number; output_per_mtok_usd: number };

/**
 * Anthropic bills an image at approximately `width * height / 750` tokens.
 *
 * Kept as a named constant with its own test rather than inlined, because it is
 * the single number the whole estimate turns on: at the observer's 1400px
 * transport cap a frame is ~1700 tokens, and being wrong by 2x here is being
 * wrong by 2x about the price of the feature.
 */
export const IMAGE_PIXELS_PER_TOKEN = 750;

/** Tokens for one image of the given pixel dimensions. */
export function imageTokens(width: number, height: number): number {
  if (width <= 0 || height <= 0) return 0;
  return Math.ceil((width * height) / IMAGE_PIXELS_PER_TOKEN);
}

export interface SessionEstimateInput {
  /** Session length the user chose. */
  maxSeconds: number;
  /** Seconds between capture attempts (the observer's cadence). */
  cadenceSeconds: number;
  /** Longest edge after the transport downscale. */
  frameWidth: number;
  frameHeight: number;
  /** Tokens in the instruction sent with every frame. */
  systemPromptTokens: number;
  /**
   * Tokens the reply is expected to use, per frame.
   *
   * NOT the `max_tokens` cap. Billing is on tokens actually produced, and a reply
   * is one small JSON object — modelling it at the cap overstated the cost of a
   * 15-minute session by roughly 8x on the first attempt at this, which would
   * have made the feature look unaffordable when it is not.
   */
  expectedOutputTokens: number;
  price: TokenPrice;
}

export interface SessionEstimate {
  /** Worst case: every tick sends a frame. */
  maxFrames: number;
  inputTokens: number;
  outputTokens: number;
  /** USD ceiling for the whole session. */
  maxCostUsd: number;
  /** USD if a frame is sent every tick for one minute. */
  costPerMinuteUsd: number;
  /**
   * Share of input tokens that is the IMAGE rather than the instruction.
   *
   * Surfaced because it names the lever: at the shipped 1400px cap the image is
   * about 80% of every request, so frame size — not prompt length, not caching —
   * is what moves the price.
   */
  imageShareOfInput: number;
}

/**
 * Ceiling cost for one session.
 *
 * "Ceiling" means every tick sends a frame, which is the worst case and not the
 * common one: identical consecutive frames are dropped by digest before egress,
 * and every gate refusal costs nothing. A user who spends ten seconds reading
 * contributes one frame, not four.
 */
export function estimateSessionCost(input: SessionEstimateInput): SessionEstimate {
  const maxFrames = Math.max(0, Math.floor(input.maxSeconds / input.cadenceSeconds));
  const perImage = imageTokens(input.frameWidth, input.frameHeight);
  const perFrameInput = perImage + input.systemPromptTokens;
  const inputTokens = maxFrames * perFrameInput;
  const outputTokens = maxFrames * input.expectedOutputTokens;
  const cost =
    (inputTokens / 1_000_000) * input.price.input_per_mtok_usd +
    (outputTokens / 1_000_000) * input.price.output_per_mtok_usd;
  const maxCostUsd = round6(cost);
  return {
    maxFrames,
    inputTokens,
    outputTokens,
    maxCostUsd,
    costPerMinuteUsd: input.maxSeconds > 0 ? round6((maxCostUsd / input.maxSeconds) * 60) : 0,
    imageShareOfInput: perFrameInput > 0 ? round6(perImage / perFrameInput) : 0,
  };
}

/**
 * The shipped defaults, so the panel and the tests describe the same feature.
 *
 * `systemPromptTokens` and `expectedOutputTokens` are measured from the real
 * prompt in `vision.rs` and a real two-action reply, not picked. If either
 * changes materially the estimate shown to the user drifts from the truth, which
 * is why they are constants with a test rather than call-site literals.
 */
export const SHIPPED_VISION_DEFAULTS = {
  cadenceSeconds: 2.5,
  frameWidth: 1400,
  frameHeight: 933,
  systemPromptTokens: 445,
  expectedOutputTokens: 128,
} as const;

/** Tokens actually consumed, as reported by the API per frame. */
export interface FrameUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface SessionSpend {
  frames: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/**
 * What a session has actually spent.
 *
 * Reported alongside the estimate rather than instead of it: a running total that
 * tracks well under its ceiling is the evidence that the ceiling was honest, and
 * one that approaches it is the signal that the cadence or the frame size needs
 * revisiting.
 */
export function sessionSpend(usages: readonly FrameUsage[], price: TokenPrice): SessionSpend {
  const inputTokens = usages.reduce((sum, u) => sum + Math.max(0, u.inputTokens), 0);
  const outputTokens = usages.reduce((sum, u) => sum + Math.max(0, u.outputTokens), 0);
  return {
    frames: usages.length,
    inputTokens,
    outputTokens,
    costUsd: round6(
      (inputTokens / 1_000_000) * price.input_per_mtok_usd +
        (outputTokens / 1_000_000) * price.output_per_mtok_usd,
    ),
  };
}

/** Money, to the precision used everywhere else in this codebase. */
function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/** A short, honest phrase for a cost the user is about to authorise. */
export function describeCostCeiling(estimate: SessionEstimate): string {
  if (estimate.maxCostUsd === 0) return "no model cost (nothing is configured to run)";
  // Below a cent, "$0.00" reads as free, which it is not.
  const amount =
    estimate.maxCostUsd < 0.01 ? "under $0.01" : `up to about $${estimate.maxCostUsd.toFixed(2)}`;
  return `${amount}, if every one of ${estimate.maxFrames} moments has to be looked at`;
}
