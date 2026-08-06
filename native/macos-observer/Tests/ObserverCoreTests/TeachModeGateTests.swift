import XCTest

@testable import ObserverCore

/// `domain/teach-egress-conformance.json` is generated from the TypeScript
/// egress gate (`packages/teach-mode/src/redact.ts`), which is the specification.
/// This Swift mirror is the copy that actually stands between captured pixels and
/// the network, so a disagreement here is not a style bug — it is a frame the
/// specification would have refused. A MISSING fixture fails, never skips.
final class TeachModeGateTests: XCTestCase {

    struct Fixture: Decodable {
        let cases: [Case]
    }
    struct Case: Decodable {
        struct Ctx: Decodable {
            struct Sess: Decodable {
                let session_id: String
                let max_seconds: Int
                let scope_bundle_ids: [String]
            }
            struct Region: Decodable {
                let text: String
                let x: Double
                let y: Double
                let width: Double
                let height: Double
                let secure: Bool
            }
            let session: Sess?
            let bundle_id: String?
            let elapsed_seconds: Double
            let paused: Bool
            let hard_denied_bundle_ids: [String]
            let private_bundle_ids: [String]
            let private_browsing: Bool
            let secure_field_focused: Bool
            let text_regions: [Region]
        }
        struct Expected: Decodable {
            struct Mask: Decodable {
                let x: Int
                let y: Int
                let width: Int
                let height: Int
                let reason: String
            }
            let send: Bool
            let reason: String?
            let masks: [Mask]
        }
        let name: String
        let context: Ctx
        let expected: Expected
    }

    static func fixtureURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // TeachModeGateTests.swift -> ObserverCoreTests
            .deletingLastPathComponent()  // -> Tests
            .deletingLastPathComponent()  // -> macos-observer
            .deletingLastPathComponent()  // -> native
            .deletingLastPathComponent()  // -> repo root
            .appendingPathComponent("domain/teach-egress-conformance.json")
    }

    static func gateContext(_ ctx: Case.Ctx) -> TeachModeGate.Context {
        TeachModeGate.Context(
            session: ctx.session.map {
                TeachModeGate.Session(
                    sessionId: $0.session_id, maxSeconds: $0.max_seconds,
                    scopeBundleIds: $0.scope_bundle_ids)
            },
            bundleId: ctx.bundle_id,
            elapsedSeconds: ctx.elapsed_seconds,
            paused: ctx.paused,
            hardDeniedBundleIds: ctx.hard_denied_bundle_ids,
            privateBundleIds: ctx.private_bundle_ids,
            privateBrowsing: ctx.private_browsing,
            secureFieldFocused: ctx.secure_field_focused,
            textRegions: ctx.text_regions.map {
                TeachModeGate.TextRegion(
                    text: $0.text, x: $0.x, y: $0.y, width: $0.width, height: $0.height,
                    secure: $0.secure)
            })
    }

    func testMatchesTheTypescriptGateOnEveryConformanceCase() throws {
        let data = try Data(contentsOf: Self.fixtureURL())
        let fixture = try JSONDecoder().decode(Fixture.self, from: data)
        XCTAssertGreaterThan(fixture.cases.count, 15, "fixture has cases")

        for c in fixture.cases {
            let decision = TeachModeGate.frameEgressDecision(Self.gateContext(c.context))
            switch decision {
            case let .refuse(reason):
                XCTAssertFalse(c.expected.send, "\(c.name): TS sends, Swift refuses (\(reason))")
                XCTAssertEqual(reason, c.expected.reason, c.name)
            case let .send(masks):
                XCTAssertTrue(c.expected.send, "\(c.name): TS refuses, Swift sends")
                XCTAssertEqual(masks.count, c.expected.masks.count, c.name)
                for (got, want) in zip(masks, c.expected.masks) {
                    XCTAssertEqual(got.x, want.x, c.name)
                    XCTAssertEqual(got.y, want.y, c.name)
                    XCTAssertEqual(got.width, want.width, c.name)
                    XCTAssertEqual(got.height, want.height, c.name)
                    XCTAssertEqual(got.reason, want.reason, c.name)
                }
            }
        }
    }
}
