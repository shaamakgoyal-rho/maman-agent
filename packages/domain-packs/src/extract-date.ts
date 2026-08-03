/**
 * Date extraction for Layer 5 date-driven triggers (`term_end` and friends).
 *
 * FAIL-SAFE DIRECTION. The amount/percent extractors in `extract.ts` fail CLOSED
 * because they guard a policy threshold: "I could not read it" must behave like
 * "over the limit". A date is the opposite kind of input — it decides WHEN to
 * offer help, so the fail-safe is to STAY SILENT. An unreadable or ambiguous
 * date must never produce a card; `usableDate` below is the only place that
 * decision should be made.
 *
 * AMBIGUITY IS NOT GUESSED. "03/04/2026" is 3 April or 4 March depending on the
 * reader's locale, and there is no honest way to pick. Such a read comes back
 * with confidence below the usable floor rather than a coin-flip date — being
 * silent about a renewal beats telling someone the wrong month.
 *
 * This runs on label text INSIDE the observer boundary (like label-pattern
 * matching) and on pre-approved field summaries. Only the normalized date and
 * its confidence ever leave; no substring of the source text does. The Swift
 * mirror in `native/macos-observer/Sources/ObserverCore/DateExtraction.swift`
 * must agree with this implementation on every case in
 * `domain/date-conformance.json` — both suites assert it.
 */

export type DateExtraction = {
  /** Normalized ISO calendar date (YYYY-MM-DD), or null when nothing was read. */
  date: string | null;
  /** 0..1 confidence in `date`. 0 whenever date is null. */
  confidence: number;
};

/** Below this, a date is not acted on. Mirrors LOW_CONFIDENCE_THRESHOLD. */
export const DATE_CONFIDENCE_FLOOR = 0.6;

/** Dates outside this window are not plausible business dates — refuse them. */
const MIN_YEAR = 1990;
const MAX_YEAR = 2100;

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

/** ISO / YYYY-MM-DD with - . or / separators. Year first is never ambiguous. */
const YEAR_FIRST = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/;
/** "25 Aug 2026" / "25 August, 2026" */
const DAY_MONTH_NAME = /(\d{1,2})\s+([a-z]{3,9})\.?,?\s+(\d{2,4})/i;
/** "Aug 25, 2026" / "August 25 2026" */
const MONTH_NAME_DAY = /([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{2,4})/i;
/** Numeric slash/dash form whose component order cannot be assumed. */
const NUMERIC_AMBIGUOUS = /(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isRealDate(year: number, month: number, day: number): boolean {
  if (year < MIN_YEAR || year > MAX_YEAR) return false;
  if (month < 1 || month > 12) return false;
  return day >= 1 && day <= daysInMonth(year, month);
}

function iso(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const NONE: DateExtraction = { date: null, confidence: 0 };

/** How many date-shaped runs the text contains — more means we may have picked
 * the wrong one, exactly as the amount extractor treats multiple numbers. */
function dateLikeCount(text: string): number {
  const numeric = text.match(/\d{1,4}[-/.]\d{1,2}[-/.]\d{2,4}/g) ?? [];
  const named =
    text.match(
      /\d{1,2}\s+[a-z]{3,9}\.?,?\s+\d{2,4}|[a-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{2,4}/gi,
    ) ?? [];
  return numeric.length + named.length;
}

function penalize(confidence: number, text: string): number {
  const c = dateLikeCount(text) > 1 ? confidence - 0.25 : confidence;
  return Math.max(0, Math.min(1, Number(c.toFixed(4))));
}

/**
 * Reads a calendar date from text the caller has already deemed inspectable.
 *
 * Recognized, in priority order: year-first (`2026-08-25`), month-name forms
 * (`25 Aug 2026`, `Aug 25, 2026`), then bare numeric (`08/25/2026`). Bare
 * numeric only earns usable confidence when one component EXCEEDS 12 and so
 * fixes the order; otherwise the read is reported as ambiguous, not resolved.
 */
export function extractDateIso(text: string | undefined | null): DateExtraction {
  if (!text) return NONE;
  const haystack = text.toLowerCase();

  // 1. Year-first: unambiguous by construction.
  const yf = YEAR_FIRST.exec(haystack);
  if (yf) {
    const year = Number(yf[1]);
    const month = Number(yf[2]);
    const day = Number(yf[3]);
    if (isRealDate(year, month, day)) {
      return { date: iso(year, month, day), confidence: penalize(0.95, haystack) };
    }
    return NONE; // a malformed year-first date is a bad read, not a fallback
  }

  // 2. Month names remove all order ambiguity.
  for (const [re, order] of [
    [DAY_MONTH_NAME, "dmy"],
    [MONTH_NAME_DAY, "mdy"],
  ] as const) {
    const m = re.exec(haystack);
    if (!m) continue;
    const monthToken = (order === "dmy" ? m[2] : m[1]) ?? "";
    const dayToken = order === "dmy" ? m[1] : m[2];
    const month = MONTHS[monthToken];
    if (month === undefined) continue; // a word that is not a month name
    const day = Number(dayToken);
    const rawYear = Number(m[3]);
    const twoDigit = (m[3] ?? "").length === 2;
    const year = twoDigit ? 2000 + rawYear : rawYear;
    if (!isRealDate(year, month, day)) continue;
    // A two-digit year guesses the century, so it can never be fully trusted.
    return { date: iso(year, month, day), confidence: penalize(twoDigit ? 0.5 : 0.9, haystack) };
  }

  // 3. Bare numeric: only readable when one component settles the order.
  const na = NUMERIC_AMBIGUOUS.exec(haystack);
  if (na) {
    const a = Number(na[1]);
    const b = Number(na[2]);
    const rawYear = Number(na[3]);
    const twoDigit = (na[3] ?? "").length === 2;
    const year = twoDigit ? 2000 + rawYear : rawYear;

    const aIsDay = a > 12 && b <= 12; // 25/08 → day first
    const bIsDay = b > 12 && a <= 12; // 08/25 → month first
    if (aIsDay || bIsDay) {
      const month = aIsDay ? b : a;
      const day = aIsDay ? a : b;
      if (!isRealDate(year, month, day)) return NONE;
      // 0.8, not 0.85: a bare numeric form is weaker evidence than a month
      // name, and this base is chosen so that the multi-candidate penalty lands
      // it BELOW the floor. Two numeric dates in one label and no month name to
      // disambiguate them means we genuinely do not know which is the term end.
      return { date: iso(year, month, day), confidence: penalize(twoDigit ? 0.5 : 0.8, haystack) };
    }

    // Both components are 1..12: genuinely ambiguous. Report the read at a
    // confidence BELOW the floor so no caller can act on it, and do not pretend
    // one interpretation is correct. Both readings are noted as invalid only if
    // neither forms a real date.
    if (isRealDate(year, a, b) || isRealDate(year, b, a)) {
      const first = isRealDate(year, a, b) ? iso(year, a, b) : iso(year, b, a);
      return { date: first, confidence: 0.35 };
    }
  }

  return NONE;
}

/**
 * The fail-SAFE read. Returns a date only when it was read confidently enough
 * to act on; anything else yields null and the reason why.
 *
 * Callers must not compare `extraction.confidence` themselves — that is how an
 * ambiguous "03/04/2026" ends up scheduling a card for the wrong month.
 */
export function usableDate(
  extraction: DateExtraction,
  minConfidence = DATE_CONFIDENCE_FLOOR,
): { date: string | null; reason: "ok" | "unreadable" | "low_confidence" } {
  if (extraction.date === null) return { date: null, reason: "unreadable" };
  if (extraction.confidence < minConfidence) return { date: null, reason: "low_confidence" };
  return { date: extraction.date, reason: "ok" };
}
