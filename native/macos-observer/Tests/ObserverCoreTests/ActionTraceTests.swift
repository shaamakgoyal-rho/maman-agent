import XCTest

@testable import ObserverCore

/// The native half of capture must obey the same rules as the browser half:
/// refuse the same surfaces, recover dataflow without keeping values, and emit
/// the shape the TypeScript contract accepts.
final class ActionTraceTests: XCTestCase {
    private let allowlist = ["com.apple.Numbers"]

    private func obs(
        at: String = "2026-08-10T09:00:00.000Z",
        operation: String = "press",
        role: String? = "AXButton",
        subrole: String? = nil,
        label: String? = "Save",
        menuPath: [String] = [],
        windowTitle: String? = nil,
        producesValue: Bool = false
    ) -> ActionTrace.Observation {
        ActionTrace.Observation(
            at: at,
            operation: operation,
            bundleId: "com.apple.Numbers",
            role: role,
            subrole: subrole,
            label: label,
            ancestry: [],
            menuPath: menuPath,
            windowTitle: windowTitle,
            producesValue: producesValue
        )
    }

    private func assemble(_ observations: [ActionTrace.Observation]) -> ActionTrace.Trace? {
        ActionTrace.assemble(
            observations: observations,
            traceId: "018f0000-0000-7000-8000-0000000000aa",
            appCategory: "spreadsheet",
            allowlistBundles: allowlist,
            privateApps: [],
            paused: false
        )
    }

    func testWindowTitlesAreHashedAtTheWidthTheContractRequires() {
        // 64 hex chars: `stableHash` truncates to 32 and would be REJECTED by
        // the desktop after a perfectly good capture.
        let hash = ActionTrace.titleHash("Q3 Forecast — Acme Corp")
        XCTAssertEqual(hash.count, 64)
        XCTAssertTrue(hash.allSatisfy { $0.isHexDigit })
        XCTAssertFalse(hash.contains("Acme"))
    }

    func testASecureFieldBecomesAHoleNotAStep() {
        let trace = assemble([
            obs(operation: "commit", role: "AXTextField", label: "Phone"),
            obs(at: "2026-08-10T09:00:05.000Z", operation: "commit", role: "AXSecureTextField", label: "Password"),
            obs(at: "2026-08-10T09:00:09.000Z", operation: "press", label: "Save"),
        ])
        XCTAssertEqual(trace?.steps.count, 2)
        XCTAssertEqual(trace?.protected_segments.count, 1)
        XCTAssertEqual(trace?.protected_segments.first?.reason, "secure_field")
    }

    func testAHardDeniedAppIsRefusedAndNamedOnlyByItsReason() {
        let denied = ActionTrace.Observation(
            at: "2026-08-10T09:00:00.000Z",
            operation: "commit",
            bundleId: "com.1password.1password",
            role: "AXTextField",
            label: "Login"
        )
        let trace = ActionTrace.assemble(
            observations: [denied],
            traceId: "018f0000-0000-7000-8000-0000000000bb",
            appCategory: "other",
            allowlistBundles: ["com.1password.1password"],
            privateApps: [],
            paused: false
        )
        // Nothing survived, so there is no trace at all — not an empty one.
        XCTAssertNil(trace)
    }

    func testDataflowIsRecoveredFromAReadAndAskedForOtherwise() {
        let bound = assemble([
            obs(operation: "read", role: "AXTextField", label: "Company Domain", producesValue: true),
            obs(at: "2026-08-10T09:00:03.000Z", operation: "commit", role: "AXTextField", label: "Website"),
        ])
        guard case let .fromStep(step, output) = bound?.steps[1].value_binding else {
            return XCTFail("expected the write to bind to the read")
        }
        XCTAssertEqual(step, 1)
        XCTAssertEqual(output, "Company Domain")

        let unbound = assemble([
            obs(operation: "commit", role: "AXTextField", label: "Company Domain")
        ])
        guard case let .runtimeInput(inputId, prompt) = unbound?.steps[0].value_binding else {
            return XCTFail("expected a runtime input slot")
        }
        XCTAssertEqual(inputId, "company_domain")
        XCTAssertEqual(prompt, "What should I put in Company Domain?")
    }

    func testAValueDoesNotCarryAcrossAProtectedHole() {
        // Binding through a refused field would assert dataflow the observer
        // never actually saw.
        let trace = assemble([
            obs(operation: "read", role: "AXTextField", label: "Domain", producesValue: true),
            obs(at: "2026-08-10T09:00:02.000Z", operation: "commit", role: "AXSecureTextField", label: "Password"),
            obs(at: "2026-08-10T09:00:04.000Z", operation: "commit", role: "AXTextField", label: "Website"),
        ])
        guard case .runtimeInput = trace?.steps[1].value_binding else {
            return XCTFail("a value carried across a hole")
        }
    }

    func testMenuPathsAndWritePreconditionsSurvive() {
        let trace = assemble([
            obs(
                operation: "press",
                role: "AXMenuItem",
                label: "CSV…",
                menuPath: ["File", "Export To", "CSV…"],
                windowTitle: "Q3 Forecast"
            )
        ])
        XCTAssertEqual(trace?.steps[0].target.menu_path, ["File", "Export To", "CSV…"])
        XCTAssertEqual(trace?.steps[0].target.window_title_hash?.count, 64)
        // A UI action into a background window is a lie about what happened.
        XCTAssertEqual(trace?.steps[0].preconditions.requires_foreground, true)
    }

    func testTheEncodedTraceMatchesTheContractsFieldNames() throws {
        let trace = assemble([
            obs(operation: "commit", role: "AXTextField", label: "Phone")
        ])
        let data = try JSONEncoder().encode(try XCTUnwrap(trace))
        let json = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: data) as? [String: Any])

        XCTAssertEqual(json["schema_version"] as? Int, 1)
        XCTAssertEqual(json["local_only"] as? Bool, true)
        let steps = try XCTUnwrap(json["steps"] as? [[String: Any]])
        XCTAssertEqual(steps[0]["surface"] as? String, "macos_ax")
        let binding = try XCTUnwrap(steps[0]["value_binding"] as? [String: Any])
        XCTAssertEqual(binding["kind"] as? String, "runtime_input")
        // The thing that must never appear: a typed value, under any key.
        let encoded = String(decoding: data, as: UTF8.self)
        for forbidden in ["\"value\":", "\"text\":", "\"keystrokes\":", "\"window_title\":"] {
            XCTAssertFalse(encoded.contains(forbidden), "\(forbidden) leaked into the trace")
        }
    }

    func testPausedObservationProducesNothing() {
        let trace = ActionTrace.assemble(
            observations: [obs(operation: "commit", role: "AXTextField", label: "Phone")],
            traceId: "018f0000-0000-7000-8000-0000000000cc",
            appCategory: "spreadsheet",
            allowlistBundles: allowlist,
            privateApps: [],
            paused: true
        )
        XCTAssertNil(trace)
    }
}
