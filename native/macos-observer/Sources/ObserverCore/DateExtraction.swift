import Foundation

/// Date extraction for Layer 5 date-driven triggers (`term_end` and friends).
///
/// THE BOUNDARY THIS EXISTS FOR: a renewal date lives in label text, and label
/// text may only be inspected inside this observer process. What leaves is a
/// NORMALIZED calendar date plus a confidence — never a substring of the label,
/// never the account it belongs to. A date is a narrower disclosure than the
/// label, but it is a real one: it is a value read off the user's record, not a
/// pack constant like `matchLabelPatterns` returns. Callers must therefore apply
/// `Redaction.isSensitiveLabel` FIRST, exactly as they do before hashing.
///
/// FAIL-SAFE DIRECTION: silence. This date decides WHEN Maman offers help, so an
/// unreadable or ambiguous read must produce no card at all. "03/04/2026" is
/// 3 April or 4 March depending on the reader, and there is no honest way to
/// choose — such a read is reported below the usable floor rather than resolved
/// by guessing. Telling someone their renewal is in the wrong month is worse
/// than telling them nothing.
///
/// This is a MIRROR of `packages/domain-packs/src/extract-date.ts`, which is the
/// readable specification. Both must agree on every case in
/// `domain/date-conformance.json`; the TS suite and this package's test runner
/// each assert against that file, so drift fails a build rather than shipping.
public struct DateExtraction: Equatable {
    /// Normalized ISO calendar date (YYYY-MM-DD), or nil when nothing was read.
    public let date: String?
    /// 0..1 confidence in `date`. 0 whenever date is nil.
    public let confidence: Double

    public init(date: String?, confidence: Double) {
        self.date = date
        self.confidence = confidence
    }

    public static let none = DateExtraction(date: nil, confidence: 0)
}

/// Below this, a date is not acted on. Mirrors DATE_CONFIDENCE_FLOOR in TS.
public let dateConfidenceFloor = 0.6

private let minYear = 1990
private let maxYear = 2100

private let monthNames: [String: Int] = [
    "jan": 1, "january": 1,
    "feb": 2, "february": 2,
    "mar": 3, "march": 3,
    "apr": 4, "april": 4,
    "may": 5,
    "jun": 6, "june": 6,
    "jul": 7, "july": 7,
    "aug": 8, "august": 8,
    "sep": 9, "sept": 9, "september": 9,
    "oct": 10, "october": 10,
    "nov": 11, "november": 11,
    "dec": 12, "december": 12,
]

private func daysInMonth(year: Int, month: Int) -> Int {
    switch month {
    case 1, 3, 5, 7, 8, 10, 12: return 31
    case 4, 6, 9, 11: return 30
    case 2:
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
        return leap ? 29 : 28
    default: return 0
    }
}

private func isRealDate(year: Int, month: Int, day: Int) -> Bool {
    guard year >= minYear, year <= maxYear, month >= 1, month <= 12 else { return false }
    return day >= 1 && day <= daysInMonth(year: year, month: month)
}

private func iso(year: Int, month: Int, day: Int) -> String {
    String(format: "%04d-%02d-%02d", year, month, day)
}

/// Rounds to 4 decimals the same way the TS side does, so fixture equality holds.
private func round4(_ value: Double) -> Double {
    (value * 10000).rounded() / 10000
}

private func firstMatch(_ pattern: String, _ text: String) -> [String]? {
    guard let re = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
        return nil
    }
    let range = NSRange(text.startIndex..<text.endIndex, in: text)
    guard let m = re.firstMatch(in: text, options: [], range: range) else { return nil }
    var groups: [String] = []
    for i in 0..<m.numberOfRanges {
        guard let r = Range(m.range(at: i), in: text) else {
            groups.append("")
            continue
        }
        groups.append(String(text[r]))
    }
    return groups
}

private func matchCount(_ pattern: String, _ text: String) -> Int {
    guard let re = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
        return 0
    }
    let range = NSRange(text.startIndex..<text.endIndex, in: text)
    return re.numberOfMatches(in: text, options: [], range: range)
}

private let yearFirstPattern = "(\\d{4})[-/.](\\d{1,2})[-/.](\\d{1,2})"
private let dayMonthNamePattern = "(\\d{1,2})\\s+([a-z]{3,9})\\.?,?\\s+(\\d{2,4})"
private let monthNameDayPattern = "([a-z]{3,9})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{2,4})"
private let numericPattern = "(\\d{1,2})[-/.](\\d{1,2})[-/.](\\d{2,4})"

/// How many date-shaped runs the text contains — more means we may have picked
/// the wrong one, so confidence drops.
private func dateLikeCount(_ text: String) -> Int {
    matchCount("\\d{1,4}[-/.]\\d{1,2}[-/.]\\d{2,4}", text)
        + matchCount(
            "\\d{1,2}\\s+[a-z]{3,9}\\.?,?\\s+\\d{2,4}|[a-z]{3,9}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{2,4}",
            text)
}

private func penalize(_ confidence: Double, _ text: String) -> Double {
    let c = dateLikeCount(text) > 1 ? confidence - 0.25 : confidence
    return max(0, min(1, round4(c)))
}

/// Reads a calendar date from text the caller has already deemed inspectable.
///
/// Recognized, in priority order: year-first (`2026-08-25`), month-name forms
/// (`25 Aug 2026`, `Aug 25, 2026`), then bare numeric (`08/25/2026`). Bare
/// numeric only earns usable confidence when one component EXCEEDS 12 and so
/// fixes the order; otherwise the read is reported as ambiguous, not resolved.
public func extractDateIso(_ text: String?) -> DateExtraction {
    guard let text, !text.isEmpty else { return .none }
    let haystack = text.lowercased()

    // 1. Year-first: unambiguous by construction.
    if let g = firstMatch(yearFirstPattern, haystack),
        let year = Int(g[1]), let month = Int(g[2]), let day = Int(g[3])
    {
        if isRealDate(year: year, month: month, day: day) {
            return DateExtraction(
                date: iso(year: year, month: month, day: day),
                confidence: penalize(0.95, haystack))
        }
        // A malformed year-first date is a bad read, not a reason to fall back.
        return .none
    }

    // 2. Month names remove all order ambiguity.
    for (pattern, dayFirst) in [(dayMonthNamePattern, true), (monthNameDayPattern, false)] {
        guard let g = firstMatch(pattern, haystack) else { continue }
        let monthToken = dayFirst ? g[2] : g[1]
        let dayToken = dayFirst ? g[1] : g[2]
        guard let month = monthNames[monthToken] else { continue }
        guard let day = Int(dayToken), let rawYear = Int(g[3]) else { continue }
        let twoDigit = g[3].count == 2
        let year = twoDigit ? 2000 + rawYear : rawYear
        guard isRealDate(year: year, month: month, day: day) else { continue }
        // A two-digit year guesses the century, so it can never be fully trusted.
        return DateExtraction(
            date: iso(year: year, month: month, day: day),
            confidence: penalize(twoDigit ? 0.5 : 0.9, haystack))
    }

    // 3. Bare numeric: only readable when one component settles the order.
    if let g = firstMatch(numericPattern, haystack),
        let a = Int(g[1]), let b = Int(g[2]), let rawYear = Int(g[3])
    {
        let twoDigit = g[3].count == 2
        let year = twoDigit ? 2000 + rawYear : rawYear
        let aIsDay = a > 12 && b <= 12  // 25/08 → day first
        let bIsDay = b > 12 && a <= 12  // 08/25 → month first
        if aIsDay || bIsDay {
            let month = aIsDay ? b : a
            let day = aIsDay ? a : b
            guard isRealDate(year: year, month: month, day: day) else { return .none }
            // 0.8, not 0.85: weaker evidence than a month name, and chosen so the
            // multi-candidate penalty lands it BELOW the floor.
            return DateExtraction(
                date: iso(year: year, month: month, day: day),
                confidence: penalize(twoDigit ? 0.5 : 0.8, haystack))
        }
        // Both components are 1..12: genuinely ambiguous. Report the read below
        // the floor so no caller can act on it, and never pretend one
        // interpretation is correct.
        if isRealDate(year: year, month: a, day: b) || isRealDate(year: year, month: b, day: a) {
            let first =
                isRealDate(year: year, month: a, day: b)
                ? iso(year: year, month: a, day: b) : iso(year: year, month: b, day: a)
            return DateExtraction(date: first, confidence: 0.35)
        }
    }

    return .none
}

/// The fail-SAFE read: a date only when it was read confidently enough to act
/// on. Callers must not compare `confidence` themselves — that is how an
/// ambiguous "03/04/2026" ends up scheduling a card for the wrong month.
public func usableDate(_ extraction: DateExtraction, minConfidence: Double = dateConfidenceFloor)
    -> String?
{
    guard let date = extraction.date else { return nil }
    return extraction.confidence < minConfidence ? nil : date
}
