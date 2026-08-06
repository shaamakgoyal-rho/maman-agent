import type { ModelUsage } from "./provider.js";

/**
 * Deterministic model pricing. Prices are data, keyed by the model alias the
 * provider reports in `ModelUsage.model_alias` — never hardcoded into logic.
 * USD per 1,000,000 tokens. The demo alias is free so the demo path costs $0.
 */

export type ModelPrice = { input_per_mtok_usd: number; output_per_mtok_usd: number };

export const DEFAULT_MODEL_PRICES: Record<string, ModelPrice> = {
  demo: { input_per_mtok_usd: 0, output_per_mtok_usd: 0 },
  "claude-haiku-4-5-20251001": { input_per_mtok_usd: 1, output_per_mtok_usd: 5 },
  "claude-sonnet-5": { input_per_mtok_usd: 3, output_per_mtok_usd: 15 },
  "claude-opus-4-8": { input_per_mtok_usd: 15, output_per_mtok_usd: 75 },
};

/**
 * Price used to quote a Teach Mode session before the user starts it.
 *
 * Resolved from the configured vision model when it is priced above, and otherwise
 * from the DEAREST known price rather than zero. Quoting $0 for an unpriced model
 * would understate a real spend, and understating the cost of the one feature that
 * sends pictures of someone's screen somewhere is the wrong direction to be wrong
 * in.
 */
export function visionSessionPrice(
  modelAlias: string,
  prices: Record<string, ModelPrice> = DEFAULT_MODEL_PRICES,
): ModelPrice {
  const known = prices[modelAlias];
  if (known) return known;
  if (modelAlias === "" || modelAlias === "demo") {
    return { input_per_mtok_usd: 0, output_per_mtok_usd: 0 };
  }
  return Object.values(prices).reduce(
    (dearest, price) => (price.input_per_mtok_usd > dearest.input_per_mtok_usd ? price : dearest),
    { input_per_mtok_usd: 0, output_per_mtok_usd: 0 },
  );
}

/**
 * Cost for a single model call. An unknown alias costs 0 but is reported so the
 * caller can surface "unpriced model" rather than silently under-count — here
 * we return 0 and let the alias travel with the usage for auditing.
 */
export function modelCostUsd(
  usage: ModelUsage,
  prices: Record<string, ModelPrice> = DEFAULT_MODEL_PRICES,
): number {
  const price = prices[usage.model_alias];
  if (!price) return 0;
  const cost =
    (usage.input_tokens / 1_000_000) * price.input_per_mtok_usd +
    (usage.output_tokens / 1_000_000) * price.output_per_mtok_usd;
  // Round to 6 dp (money precision used everywhere else).
  return Math.round(cost * 1_000_000) / 1_000_000;
}

/** Sums usage across model calls into a single ModelUsage (alias of the priciest). */
export function sumUsage(usages: ModelUsage[]): ModelUsage {
  if (usages.length === 0) return { input_tokens: 0, output_tokens: 0, model_alias: "demo" };
  return {
    input_tokens: usages.reduce((s, u) => s + u.input_tokens, 0),
    output_tokens: usages.reduce((s, u) => s + u.output_tokens, 0),
    // Report the last non-demo alias, else demo.
    model_alias:
      usages
        .map((u) => u.model_alias)
        .filter((a) => a !== "demo")
        .at(-1) ?? "demo",
  };
}
