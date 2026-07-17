import XCTest
@testable import ObserverCore

final class RedactionTests: XCTestCase {
    let allowlist = ["com.google.Chrome", "com.salesforce.chatter"]

    func testSecureTextFieldsAreBoundaries() {
        let decision = decideObservation(
            bundleId: "com.google.Chrome", appName: "Chrome",
            role: "AXSecureTextField", subrole: nil, label: nil,
            allowlistBundles: allowlist, privateApps: [], paused: false
        )
        XCTAssertEqual(decision, .boundary(.secureField))
    }

    func testSensitiveLabelsAreBoundaries() {
        for label in ["Password", "One-Time Code", "Card Number", "SSN", "API Key"] {
            let decision = decideObservation(
                bundleId: "com.google.Chrome", appName: "Chrome",
                role: "AXTextField", subrole: nil, label: label,
                allowlistBundles: allowlist, privateApps: [], paused: false
            )
            XCTAssertEqual(decision, .boundary(.secureField), "label \(label) must redact")
        }
    }

    func testHardDeniedAppsAreBoundaries() {
        for bundle in ["com.1password.1password", "com.apple.keychainaccess"] {
            let decision = decideObservation(
                bundleId: bundle, appName: nil,
                role: nil, subrole: nil, label: nil,
                allowlistBundles: allowlist + [bundle], // even if allowlisted!
                privateApps: [], paused: false
            )
            XCTAssertEqual(decision, .boundary(.hardDenied), "\(bundle) must be denied")
        }
    }

    func testUserPrivateAppsAreBoundaries() {
        let decision = decideObservation(
            bundleId: "com.figma.Desktop", appName: "Figma",
            role: nil, subrole: nil, label: nil,
            allowlistBundles: allowlist + ["com.figma.Desktop"],
            privateApps: ["figma"], paused: false
        )
        XCTAssertEqual(decision, .boundary(.userPrivate))
    }

    func testNonAllowlistedAppsAreDroppedSilently() {
        let decision = decideObservation(
            bundleId: "com.apple.TextEdit", appName: "TextEdit",
            role: "AXButton", subrole: nil, label: "Save",
            allowlistBundles: allowlist, privateApps: [], paused: false
        )
        XCTAssertEqual(decision, .drop)
    }

    func testPausedDropsEverything() {
        let decision = decideObservation(
            bundleId: "com.google.Chrome", appName: "Chrome",
            role: "AXButton", subrole: nil, label: "Send",
            allowlistBundles: allowlist, privateApps: [], paused: true
        )
        XCTAssertEqual(decision, .drop)
    }

    func testAllowlistedBenignElementsEmit() {
        let decision = decideObservation(
            bundleId: "com.google.Chrome", appName: "Chrome",
            role: "AXButton", subrole: nil, label: "New Record",
            allowlistBundles: allowlist, privateApps: [], paused: false
        )
        XCTAssertEqual(decision, .emit)
    }

    func testStableHashNeverEchoesInput() {
        let hash = stableHash("Quarterly Board Deck.key")
        XCTAssertEqual(hash.count, 32)
        XCTAssertFalse(hash.contains("Quarterly"))
        XCTAssertEqual(hash, stableHash("Quarterly Board Deck.key"), "hash is stable")
        XCTAssertNotEqual(hash, stableHash("other"))
    }
}
