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
            .configure(allowlistBundles: ["a"], allowlistDomains: [], privateApps: ["b"])
        )
    }

    func testTeachModeIsTimeBoxed() {
        XCTAssertEqual(
            ObserverControl.parse(line: #"{"type":"teach_mode_start","max_seconds":300}"#),
            .teachModeStart(maxSeconds: 300)
        )
        XCTAssertNil(
            ObserverControl.parse(line: #"{"type":"teach_mode_start","max_seconds":901}"#),
            "sessions above 15 minutes are rejected at the protocol layer"
        )
    }

    func testUnknownControlTypesAreRejected() {
        XCTAssertNil(ObserverControl.parse(line: #"{"type":"capture_keystrokes"}"#))
        XCTAssertNil(ObserverControl.parse(line: "not json"))
    }
}
