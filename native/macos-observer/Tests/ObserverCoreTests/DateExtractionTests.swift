import XCTest

@testable import ObserverCore

/// The anti-drift contract for date extraction.
///
/// `domain/date-conformance.json` is generated from the TypeScript
/// specification (`packages/domain-packs/src/extract-date.ts`), and the TS suite
/// asserts the same file. The code that reads a live label runs HERE, inside the
/// observer boundary, so a disagreement between the two implementations would
/// mean a renewal card fired for the wrong month. CI runs this suite, so drift
/// fails a build instead of shipping.
final class DateExtractionTests: XCTestCase {

    private struct DateCase: Decodable {
        struct Expected: Decodable {
            let date: String?
            let confidence: Double
        }
        let name: String
        let text: String
        let expected: Expected
    }

    /// Repo root, derived from this file's location so the test is
    /// working-directory independent.
    private var conformanceURL: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // DateExtractionTests.swift -> ObserverCoreTests
            .deletingLastPathComponent()  // -> Tests
            .deletingLastPathComponent()  // -> macos-observer
            .deletingLastPathComponent()  // -> native
            .deletingLastPathComponent()  // -> repo root
            .appendingPathComponent("domain/date-conformance.json")
    }

    func testMatchesTypeScriptOracleOnEveryCase() throws {
        // A missing fixture must FAIL, never skip: silently passing is how the
        // two implementations drift apart unnoticed.
        let data = try Data(contentsOf: conformanceURL)
        let cases = try JSONDecoder().decode([DateCase].self, from: data)
        XCTAssertGreaterThan(cases.count, 20, "fixture should cover a real range of inputs")

        for c in cases {
            let got = extractDateIso(c.text)
            XCTAssertEqual(got.date, c.expected.date, "date for case: \(c.name)")
            XCTAssertEqual(
                got.confidence, c.expected.confidence, accuracy: 0.0001,
                "confidence for case: \(c.name)")
        }
    }

    func testFixtureCoversAmbiguityNotJustSuccess() throws {
        let data = try Data(contentsOf: conformanceURL)
        let cases = try JSONDecoder().decode([DateCase].self, from: data)
        XCTAssertTrue(cases.contains { $0.expected.date == nil }, "needs unreadable cases")
        XCTAssertTrue(
            cases.contains { $0.expected.confidence >= dateConfidenceFloor },
            "needs usable cases")
        // The case that matters most: a date WAS read but must not be acted on.
        XCTAssertTrue(
            cases.contains {
                $0.expected.date != nil && $0.expected.confidence < dateConfidenceFloor
            },
            "needs a read-but-unusable case — that is the ambiguity behaviour")
    }

    func testFailSafeDirectionIsSilence() {
        // 3 April or 4 March? Never guessed.
        XCTAssertNil(usableDate(extractDateIso("expires 03/04/2026")))
        XCTAssertNil(usableDate(extractDateIso("renewal 25/08/26")))  // 2-digit year
        XCTAssertNil(usableDate(extractDateIso("no date here")))
        XCTAssertEqual(usableDate(extractDateIso("term end 2026-08-25")), "2026-08-25")
    }

    func testOnlyTheNormalizedDateEscapes() {
        let label = "Northwind Traders — renewal term end 2026-08-25 (owner: dana@example.com)"
        let r = extractDateIso(label)
        XCTAssertEqual(r.date, "2026-08-25")
        // Nothing that could carry content may appear in the result.
        for fragment in ["Northwind", "dana", "example.com", "owner", "renewal"] {
            XCTAssertFalse(r.date?.contains(fragment) ?? false, "leaked \(fragment)")
        }
    }

    func testImpossibleDatesAreRefusedNotClamped() {
        for text in ["2026-02-30", "2026-13-01", "31/02/2026", "Feb 30, 2026", "2027-02-29"] {
            XCTAssertNil(extractDateIso(text).date, "should refuse: \(text)")
        }
        XCTAssertEqual(extractDateIso("2028-02-29").date, "2028-02-29", "real leap day")
    }
}
