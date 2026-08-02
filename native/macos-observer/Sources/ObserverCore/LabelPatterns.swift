import Foundation

/// Domain-pack label-pattern matching (L1 detection hint).
///
/// THE BOUNDARY THIS EXISTS FOR: raw label text may be inspected only inside
/// this observer process, pre-hash. What leaves is the list of PATTERN strings
/// that fired — pack constants from committed YAML — never the text they fired
/// against. Emitting "invoice matched" reveals pack membership, the same
/// privacy class as `object_type`; emitting the label itself would leak
/// content, so no code path returns any substring of `label`.
///
/// Patterns are case-insensitive literal substrings (not regexes): pack
/// authors write hints like "INV-", "amount due", "purchase order".
///
/// Callers must apply `Redaction.isSensitiveLabel` FIRST — a sensitive label
/// must never even be pattern-matched.
public func matchLabelPatterns(label: String, patterns: [String]) -> [String] {
    guard !patterns.isEmpty, !label.isEmpty else { return [] }
    let haystack = label.lowercased()
    var hits = patterns.filter { pattern in
        !pattern.isEmpty && haystack.contains(pattern.lowercased())
    }
    // Deterministic output regardless of configured order; bounded so a
    // pathological pack cannot bloat every event.
    hits.sort()
    if hits.count > 8 { hits = Array(hits.prefix(8)) }
    return hits
}
