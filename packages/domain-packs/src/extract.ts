/**
 * Amount / percent extraction for policy matchers (`amount_usd_gt`,
 * `discount_pct_gt`).
 *
 * THE CENTRAL RULE: extraction failure must FAIL CLOSED. A policy threshold is
 * a guard, so "I could not read the amount" has to behave like "the amount is
 * over the limit", never like "the amount is fine". `exceedsThreshold` below is
 * the only place that comparison should be made.
 *
 * These operate on values the observer already deemed emittable (item counts,
 * numeric field summaries) — NOT on raw typed text.
 */

export type Extraction = {
  /** Parsed value, or null when nothing could be read. */
  value: number | null;
  /** 0..1 confidence in `value`. 0 whenever value is null. */
  confidence: number;
};

export const LOW_CONFIDENCE_THRESHOLD = 0.6;

const AMOUNT = /(?:^|[^\d.,])(?:usd\s*|\$)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/i;
const PERCENT = /(\d{1,3}(?:\.\d{1,2})?)\s*%/;

/**
 * Reads a USD amount from a pre-approved numeric summary string.
 * Confidence reflects how unambiguous the read was: an explicit currency marker
 * is stronger evidence than a bare number.
 */
export function extractAmountUsd(text: string | undefined | null): Extraction {
  if (!text) return { value: null, confidence: 0 };
  const match = AMOUNT.exec(text);
  if (!match) return { value: null, confidence: 0 };

  const whole = (match[1] ?? "").replace(/,/g, "");
  const cents = match[2] ?? "";
  const value = Number(cents ? `${whole}.${cents}` : whole);
  if (!Number.isFinite(value)) return { value: null, confidence: 0 };

  const explicitCurrency = /usd|\$/i.test(text);
  // More than one candidate number means we may have grabbed the wrong one.
  const numberCount = (text.match(/\d+(?:[.,]\d+)*/g) ?? []).length;
  let confidence = explicitCurrency ? 0.9 : 0.5;
  if (numberCount > 1) confidence -= 0.25;
  return { value, confidence: Math.max(0, Math.min(1, Number(confidence.toFixed(4)))) };
}

/** Reads a percentage. A bare number with no "%" is not a percentage. */
export function extractDiscountPct(text: string | undefined | null): Extraction {
  if (!text) return { value: null, confidence: 0 };
  const match = PERCENT.exec(text);
  if (!match) return { value: null, confidence: 0 };
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    return { value: null, confidence: 0 };
  }
  const numberCount = (text.match(/\d+(?:\.\d+)?\s*%/g) ?? []).length;
  return { value, confidence: numberCount > 1 ? 0.6 : 0.9 };
}

/**
 * The fail-closed comparison. Returns true (threshold exceeded → gate harder)
 * when the value is missing OR its confidence is too low to rely on.
 *
 * Callers must not compare `extraction.value` to a threshold themselves; doing
 * so is how a failed extraction silently slips under a limit.
 */
export function exceedsThreshold(
  extraction: Extraction,
  threshold: number,
  minConfidence = LOW_CONFIDENCE_THRESHOLD,
): { exceeded: boolean; reason: "over_threshold" | "unreadable" | "low_confidence" | "under" } {
  if (extraction.value === null) return { exceeded: true, reason: "unreadable" };
  if (extraction.confidence < minConfidence) return { exceeded: true, reason: "low_confidence" };
  return extraction.value > threshold
    ? { exceeded: true, reason: "over_threshold" }
    : { exceeded: false, reason: "under" };
}
