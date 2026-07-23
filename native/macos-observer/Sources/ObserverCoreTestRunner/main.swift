import Foundation
import ObserverCore

// Assertion runner mirroring ObserverCoreTests for machines without XCTest
// (Command Line Tools only). CI runs the full XCTest suite; this executable
// keeps the same checks runnable everywhere. Exits non-zero on any failure.

var failures = 0
func check(_ condition: Bool, _ name: String) {
    if condition {
        print("ok - \(name)")
    } else {
        failures += 1
        print("FAIL - \(name)")
    }
}

let allowlist = ["com.google.Chrome", "com.salesforce.chatter"]

// --- redaction ---
check(
    decideObservation(
        bundleId: "com.google.Chrome", appName: "Chrome", role: "AXSecureTextField",
        subrole: nil, label: nil, allowlistBundles: allowlist, privateApps: [], paused: false
    ) == .boundary(.secureField),
    "secure text fields are boundaries"
)
for label in ["Password", "One-Time Code", "Card Number", "SSN", "API Key"] {
    check(
        decideObservation(
            bundleId: "com.google.Chrome", appName: "Chrome", role: "AXTextField",
            subrole: nil, label: label, allowlistBundles: allowlist, privateApps: [], paused: false
        ) == .boundary(.secureField),
        "sensitive label \(label) redacts"
    )
}
for bundle in ["com.1password.1password", "com.apple.keychainaccess"] {
    check(
        decideObservation(
            bundleId: bundle, appName: nil, role: nil, subrole: nil, label: nil,
            allowlistBundles: allowlist + [bundle], privateApps: [], paused: false
        ) == .boundary(.hardDenied),
        "hard denied app \(bundle)"
    )
}
check(
    decideObservation(
        bundleId: "com.figma.Desktop", appName: "Figma", role: nil, subrole: nil, label: nil,
        allowlistBundles: allowlist + ["com.figma.Desktop"], privateApps: ["figma"], paused: false
    ) == .boundary(.userPrivate),
    "user private app is boundary"
)
check(
    decideObservation(
        bundleId: "com.apple.TextEdit", appName: "TextEdit", role: "AXButton", subrole: nil,
        label: "Save", allowlistBundles: allowlist, privateApps: [], paused: false
    ) == .drop,
    "non-allowlisted apps drop silently"
)
// Wildcard "*" (the user's explicit "observe every app" opt-in): any non-denied
// app emits, but hard-denied / private / secure contexts STILL boundary out.
check(
    decideObservation(
        bundleId: "com.apple.TextEdit", appName: "TextEdit", role: "AXButton", subrole: nil,
        label: "Save", allowlistBundles: ["*"], privateApps: [], paused: false
    ) == .emit,
    "wildcard observes a previously non-allowlisted app"
)
check(
    decideObservation(
        bundleId: "com.1password.1password", appName: "1Password", role: nil, subrole: nil,
        label: nil, allowlistBundles: ["*"], privateApps: [], paused: false
    ) == .boundary(.hardDenied),
    "wildcard still hard-denies a password manager"
)
check(
    decideObservation(
        bundleId: "com.apple.TextEdit", appName: "TextEdit", role: "AXSecureTextField",
        subrole: nil, label: nil, allowlistBundles: ["*"], privateApps: [], paused: false
    ) == .boundary(.secureField),
    "wildcard still boundaries secure text fields"
)
check(
    decideObservation(
        bundleId: "com.google.Chrome", appName: "Chrome", role: "AXButton", subrole: nil,
        label: "Send", allowlistBundles: allowlist, privateApps: [], paused: true
    ) == .drop,
    "paused drops everything"
)
check(
    decideObservation(
        bundleId: "com.google.Chrome", appName: "Chrome", role: "AXButton", subrole: nil,
        label: "New Record", allowlistBundles: allowlist, privateApps: [], paused: false
    ) == .emit,
    "allowlisted benign elements emit"
)
let h = stableHash("Quarterly Board Deck.key")
check(h.count == 32 && !h.contains("Quarterly") && h == stableHash("Quarterly Board Deck.key"),
      "stable hash never echoes input")

// --- protocol ---
func decode(_ line: String) -> [String: Any]? {
    line.data(using: .utf8).flatMap {
        (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any]
    }
}

if let line = try? ObserverMessage.hello(observerVersion: "0.1.0", capabilities: ["macos_ax"], pid: 42).jsonLine(),
   let json = decode(line) {
    check(json["type"] as? String == "hello" && json["pid"] as? Int == 42 && !line.contains("\n"),
          "hello line shape")
} else {
    check(false, "hello line shape")
}

if let line = try? ObserverMessage.boundary(reason: .hardDenied, occurredAt: "2026-07-17T18:00:00.000Z").jsonLine(),
   let json = decode(line) {
    check(json["app"] == nil && json["bundle_id"] == nil && json["display_name"] == nil,
          "boundary carries no app identity")
} else {
    check(false, "boundary carries no app identity")
}

let event = SemanticEvent(
    eventId: "e1", deviceId: "d1", userId: "u1", organizationId: "o1",
    occurredAt: "2026-07-17T18:00:00.000Z", monotonicMs: 5,
    app: .init(bundleId: "com.google.Chrome", displayName: "Chrome"),
    eventType: "element_focused",
    target: .init(role: "AXButton", semanticType: nil, stableIdHash: "abc", labelHash: nil),
    context: .init(), durationMs: nil, sensitivity: "internal",
    redaction: .init(applied: false, reasons: [])
)
if let line = try? ObserverMessage.event(event).jsonLine(),
   let json = decode(line), let payload = json["event"] as? [String: Any] {
    check(payload["schema_version"] as? Int == 1
          && payload["event_type"] as? String == "element_focused"
          && (payload["app"] as? [String: Any])?["display_name"] as? String == "Chrome",
          "event line uses snake_case wire format")
} else {
    check(false, "event line uses snake_case wire format")
}

check(ObserverControl.parse(line: #"{"type":"pause"}"#) == .pause, "control pause parses")
check(ObserverControl.parse(line: #"{"type":"teach_mode_start","max_seconds":300}"#)
      == .teachModeStart(maxSeconds: 300), "teach mode within box parses")
check(ObserverControl.parse(line: #"{"type":"teach_mode_start","max_seconds":901}"#) == nil,
      "teach mode above 15 minutes rejected")
check(ObserverControl.parse(line: #"{"type":"capture_keystrokes"}"#) == nil,
      "unknown control types rejected (no keystroke channel)")

print(failures == 0 ? "ALL CHECKS PASSED" : "\(failures) CHECK(S) FAILED")
exit(failures == 0 ? 0 : 1)
