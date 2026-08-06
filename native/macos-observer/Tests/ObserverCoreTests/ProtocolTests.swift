import XCTest
@testable import ObserverCore

final class ProtocolTests: XCTestCase {

    func decode(_ line: String) throws -> [String: Any] {
        let data = try XCTUnwrap(line.data(using: .utf8))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testHelloLine() throws {
        let line = try ObserverMessage.hello(
            observerVersion: "0.1.0", capabilities: ["macos_ax"], pid: 42
        ).jsonLine()
        let json = try decode(line)
        XCTAssertEqual(json["type"] as? String, "hello")
        XCTAssertEqual(json["observer_version"] as? String, "0.1.0")
        XCTAssertEqual(json["pid"] as? Int, 42)
        XCTAssertFalse(line.contains("\n"))
    }

    func testBoundaryCarriesNoAppIdentity() throws {
        let line = try ObserverMessage.boundary(
            reason: .hardDenied, occurredAt: "2026-07-17T18:00:00.000Z"
        ).jsonLine()
        let json = try decode(line)
        XCTAssertEqual(json["type"] as? String, "boundary")
        XCTAssertEqual(json["reason"] as? String, "hard_denied")
        XCTAssertNil(json["app"])
        XCTAssertNil(json["bundle_id"])
        XCTAssertNil(json["display_name"])
    }

    func testEventLineUsesSnakeCaseWireFormat() throws {
        let event = SemanticEvent(
            eventId: "e1", deviceId: "d1", userId: "u1", organizationId: "o1",
            occurredAt: "2026-07-17T18:00:00.000Z", monotonicMs: 5,
            app: .init(bundleId: "com.google.Chrome", displayName: "Chrome"),
            eventType: "element_focused",
            target: .init(role: "AXButton", semanticType: nil, stableIdHash: "abc", labelHash: nil),
            context: .init(),
            durationMs: nil, sensitivity: "internal",
            redaction: .init(applied: false, reasons: [])
        )
        let json = try decode(try ObserverMessage.event(event).jsonLine())
        let payload = try XCTUnwrap(json["event"] as? [String: Any])
        XCTAssertEqual(payload["schema_version"] as? Int, 1)
        XCTAssertEqual(payload["event_type"] as? String, "element_focused")
        XCTAssertEqual((payload["app"] as? [String: Any])?["display_name"] as? String, "Chrome")
        XCTAssertEqual((payload["target"] as? [String: Any])?["stable_id_hash"] as? String, "abc")
    }

    func testControlParsing() {
        XCTAssertEqual(ObserverControl.parse(line: #"{"type":"pause"}"#), .pause)
        XCTAssertEqual(ObserverControl.parse(line: #"{"type":"resume"}"#), .resume)
        XCTAssertEqual(ObserverControl.parse(line: #"{"type":"shutdown"}"#), .shutdown)
        XCTAssertEqual(
            ObserverControl.parse(
                line: #"{"type":"configure","allowlist_bundles":["a"],"allowlist_domains":[],"private_apps":["b"]}"#
            ),
            .configure(
                allowlistBundles: ["a"], allowlistDomains: [], privateApps: ["b"],
                labelPatterns: []),
            "a configure line without label_patterns still parses (older cores)"
        )
        XCTAssertEqual(
            ObserverControl.parse(
                line: #"{"type":"configure","allowlist_bundles":["a"],"allowlist_domains":[],"private_apps":[],"label_patterns":["invoice","INV-"]}"#
            ),
            .configure(
                allowlistBundles: ["a"], allowlistDomains: [], privateApps: [],
                labelPatterns: ["invoice", "INV-"])
        )
    }

    func testLabelPatternMatchingEmitsOnlyPatternStrings() {
        let patterns = ["invoice", "INV-", "amount due"]
        // Case-insensitive substring match; output sorted and drawn ONLY from
        // the configured pattern constants — never from the label text.
        let hits = matchLabelPatterns(label: "Invoice INV-2041 — Acme Corp", patterns: patterns)
        XCTAssertEqual(hits, ["INV-", "invoice"])
        for hit in hits { XCTAssertTrue(patterns.contains(hit)) }
        XCTAssertFalse(hits.contains { $0.contains("Acme") || $0.contains("2041") })
        XCTAssertEqual(matchLabelPatterns(label: "Quarterly report", patterns: patterns), [])
        XCTAssertEqual(matchLabelPatterns(label: "", patterns: patterns), [])
        XCTAssertEqual(matchLabelPatterns(label: "invoice", patterns: []), [])
    }

    func testTeachModeIsTimeBoxedAndScoped() {
        XCTAssertEqual(
            ObserverControl.parse(
                line: #"{"type":"teach_mode_start","max_seconds":300,"session_id":"s-1","scope_bundle_ids":["com.google.Chrome"]}"#),
            .teachModeStart(
                sessionId: "s-1", maxSeconds: 300, scopeBundleIds: ["com.google.Chrome"])
        )
        XCTAssertNil(
            ObserverControl.parse(
                line: #"{"type":"teach_mode_start","max_seconds":901,"session_id":"s","scope_bundle_ids":["a"]}"#),
            "sessions above 15 minutes are rejected at the protocol layer"
        )
        // A start without a session id or scope must NOT parse: scope is what makes
        // starting a session something other than consent to film everything.
        XCTAssertNil(
            ObserverControl.parse(line: #"{"type":"teach_mode_start","max_seconds":300}"#))
        XCTAssertNil(
            ObserverControl.parse(
                line: #"{"type":"teach_mode_start","max_seconds":300,"session_id":"s","scope_bundle_ids":[]}"#))
    }

    func testUnknownControlTypesAreRejected() {
        XCTAssertNil(ObserverControl.parse(line: #"{"type":"capture_keystrokes"}"#))
        XCTAssertNil(ObserverControl.parse(line: "not json"))
    }

    /// Window geometry for the docked subtitle bar. The privacy property is that
    /// this message is a RECTANGLE and nothing else — no app identity, no title,
    /// no label — because it exists only to position a bar.
    func testWindowFrameCarriesGeometryOnly() throws {
        let line = try ObserverMessage.windowFrame(
            frame: .init(x: 120, y: 80, width: 900, height: 600),
            occurredAt: "2026-08-03T21:00:00.000Z"
        ).jsonLine()
        let json = try decode(line)
        XCTAssertEqual(json["type"] as? String, "window_frame")
        let frame = try XCTUnwrap(json["frame"] as? [String: Any])
        XCTAssertEqual(frame["x"] as? Double, 120)
        XCTAssertEqual(frame["y"] as? Double, 80)
        XCTAssertEqual(frame["width"] as? Double, 900)
        XCTAssertEqual(frame["height"] as? Double, 600)
        // Only the wire keys we intend, nothing that could identify or describe.
        XCTAssertEqual(Set(json.keys), Set(["type", "occurred_at", "frame"]))
        XCTAssertEqual(Set(frame.keys), Set(["x", "y", "width", "height"]))
    }

    /// "Nothing is being monitored" must be an explicit null so the core detaches
    /// the bar instead of leaving it pinned to a stale rectangle.
    func testClearedWindowFrameIsExplicitNull() throws {
        let line = try ObserverMessage.windowFrame(
            frame: nil, occurredAt: "2026-08-03T21:00:00.000Z"
        ).jsonLine()
        XCTAssertTrue(line.contains("\"frame\":null"), "expected an explicit null: \(line)")
        let json = try decode(line)
        XCTAssertTrue(json["frame"] is NSNull)
    }
}
