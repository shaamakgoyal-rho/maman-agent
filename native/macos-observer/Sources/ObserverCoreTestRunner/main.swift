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
check(ObserverControl.parse(line: #"{"type":"teach_mode_start","max_seconds":300,"session_id":"s-1","scope_bundle_ids":["com.google.Chrome"]}"#)
      == .teachModeStart(sessionId: "s-1", maxSeconds: 300, scopeBundleIds: ["com.google.Chrome"]),
      "teach mode within box, with session + scope, parses")
check(ObserverControl.parse(line: #"{"type":"teach_mode_start","max_seconds":901,"session_id":"s","scope_bundle_ids":["a"]}"#) == nil,
      "teach mode above 15 minutes rejected")
check(ObserverControl.parse(line: #"{"type":"teach_mode_start","max_seconds":300}"#) == nil,
      "teach mode without session id + scope rejected — scope is not optional")
check(ObserverControl.parse(line: #"{"type":"teach_mode_start","max_seconds":300,"session_id":"s","scope_bundle_ids":[]}"#) == nil,
      "teach mode with empty scope rejected")
check(ObserverControl.parse(line: #"{"type":"capture_keystrokes"}"#) == nil,
      "unknown control types rejected (no keystroke channel)")


// --- label-pattern matching (domain packs, L1 hint) ---
check(
    ObserverControl.parse(
        line: #"{"type":"configure","allowlist_bundles":["a"],"allowlist_domains":[],"private_apps":[],"label_patterns":["invoice","INV-"]}"#
    ) == .configure(
        allowlistBundles: ["a"], allowlistDomains: [], privateApps: [],
        labelPatterns: ["invoice", "INV-"]),
    "configure carries label_patterns"
)
check(
    ObserverControl.parse(
        line: #"{"type":"configure","allowlist_bundles":["a"],"allowlist_domains":[],"private_apps":[]}"#
    ) == .configure(allowlistBundles: ["a"], allowlistDomains: [], privateApps: [], labelPatterns: []),
    "configure without label_patterns still parses"
)
let packPatterns = ["invoice", "INV-", "amount due"]
let patternHits = matchLabelPatterns(label: "Invoice INV-2041 — Acme Corp", patterns: packPatterns)
check(patternHits == ["INV-", "invoice"], "pattern hits are sorted matched pattern strings")
check(
    patternHits.allSatisfy { packPatterns.contains($0) },
    "hits are drawn only from configured pattern constants (never label text)"
)
check(
    matchLabelPatterns(label: "Quarterly report", patterns: packPatterns).isEmpty,
    "non-matching label yields no hits"
)

// --- date extraction: the SAME fixture the TypeScript suite asserts ---
// domain/date-conformance.json is generated from the TS specification. If this
// Swift mirror ever disagrees, this check fails rather than a wrong renewal date
// shipping quietly. Located relative to this source file so the runner works
// from any working directory.
let conformancePath = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()  // main.swift -> ObserverCoreTestRunner
    .deletingLastPathComponent()  // -> Sources
    .deletingLastPathComponent()  // -> macos-observer
    .deletingLastPathComponent()  // -> native
    .deletingLastPathComponent()  // -> repo root
    .appendingPathComponent("domain/date-conformance.json")

struct DateCase: Decodable {
    struct Expected: Decodable {
        let date: String?
        let confidence: Double
    }
    let name: String
    let text: String
    let expected: Expected
}

if let data = try? Data(contentsOf: conformancePath),
    let cases = try? JSONDecoder().decode([DateCase].self, from: data)
{
    check(cases.count > 20, "date conformance fixture has cases (\(cases.count))")
    var mismatches: [String] = []
    for c in cases {
        let got = extractDateIso(c.text)
        if got.date != c.expected.date || abs(got.confidence - c.expected.confidence) > 0.0001 {
            mismatches.append(
                "\(c.name): got \(got.date ?? "nil")@\(got.confidence), "
                    + "want \(c.expected.date ?? "nil")@\(c.expected.confidence)")
        }
    }
    check(
        mismatches.isEmpty,
        "swift date extractor matches the TypeScript oracle on every case"
            + (mismatches.isEmpty ? "" : " — \(mismatches.joined(separator: "; "))"))
} else {
    // A missing or unreadable fixture must FAIL: silently skipping the drift
    // contract is how the two implementations diverge unnoticed.
    check(false, "date conformance fixture is readable at \(conformancePath.path)")
}

// The fail-safe direction, asserted directly rather than only via the fixture.
check(
    usableDate(extractDateIso("expires 03/04/2026")) == nil,
    "an ambiguous numeric date is never acted on"
)
check(
    usableDate(extractDateIso("term end 2026-08-25")) == "2026-08-25",
    "an unambiguous date is usable"
)
check(
    extractDateIso("Northwind Traders — renewal 2026-08-25 (dana@example.com)").date == "2026-08-25",
    "only the normalized date is returned, never label text"
)

// --- window frame (docked subtitle bar) ---
// Transient UI geometry: a rectangle, no app identity, no content.
let framed = (try? ObserverMessage.windowFrame(
    frame: .init(x: 120, y: 80, width: 900, height: 600),
    occurredAt: "2026-08-03T21:00:00.000Z"
).jsonLine()) ?? ""
check(framed.contains("\"type\":\"window_frame\""), "window_frame line uses the wire type")
for key in ["\"x\":120", "\"y\":80", "\"width\":900", "\"height\":600"] {
    check(framed.contains(key), "window_frame carries \(key)")
}
check(
    !framed.contains("bundle") && !framed.contains("display_name")
        && !framed.contains("title") && !framed.contains("label"),
    "window_frame carries NO app identity and no content — geometry only"
)
let cleared = (try? ObserverMessage.windowFrame(
    frame: nil, occurredAt: "2026-08-03T21:00:00.000Z"
).jsonLine()) ?? ""
check(
    cleared.contains("\"frame\":null"),
    "a cleared frame is an explicit null, so the core detaches the bar"
)

// --- teach-mode egress gate: cross-language drift contract ---
// domain/teach-egress-conformance.json is generated from the TS gate
// (packages/teach-mode/src/redact.ts, the specification). The Swift mirror is
// the copy that stands between captured pixels and the network, so a mismatch
// here is a frame the specification would have refused. Missing fixture FAILS.
struct TeachGateCase: Decodable {
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
struct TeachGateFixture: Decodable { let cases: [TeachGateCase] }

let teachGatePath = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .appendingPathComponent("domain/teach-egress-conformance.json")

if let data = try? Data(contentsOf: teachGatePath),
    let fixture = try? JSONDecoder().decode(TeachGateFixture.self, from: data)
{
    check(fixture.cases.count > 15, "teach-egress fixture has cases (\(fixture.cases.count))")
    var gateMismatches: [String] = []
    for c in fixture.cases {
        let context = TeachModeGate.Context(
            session: c.context.session.map {
                TeachModeGate.Session(
                    sessionId: $0.session_id, maxSeconds: $0.max_seconds,
                    scopeBundleIds: $0.scope_bundle_ids)
            },
            bundleId: c.context.bundle_id,
            elapsedSeconds: c.context.elapsed_seconds,
            paused: c.context.paused,
            hardDeniedBundleIds: c.context.hard_denied_bundle_ids,
            privateBundleIds: c.context.private_bundle_ids,
            privateBrowsing: c.context.private_browsing,
            secureFieldFocused: c.context.secure_field_focused,
            textRegions: c.context.text_regions.map {
                TeachModeGate.TextRegion(
                    text: $0.text, x: $0.x, y: $0.y, width: $0.width, height: $0.height,
                    secure: $0.secure)
            })
        switch TeachModeGate.frameEgressDecision(context) {
        case let .refuse(reason):
            if c.expected.send || reason != c.expected.reason {
                gateMismatches.append("\(c.name): swift refused (\(reason))")
            }
        case let .send(masks):
            if !c.expected.send {
                gateMismatches.append("\(c.name): swift sent, TS refused")
            } else if masks.map({ [$0.x, $0.y, $0.width, $0.height] })
                != c.expected.masks.map({ [$0.x, $0.y, $0.width, $0.height] })
                || masks.map(\.reason) != c.expected.masks.map(\.reason)
            {
                gateMismatches.append("\(c.name): mask mismatch")
            }
        }
    }
    check(
        gateMismatches.isEmpty,
        "teach-egress gate matches TS on every case"
            + (gateMismatches.isEmpty ? "" : " — " + gateMismatches.joined(separator: "; ")))
} else {
    // Deliberately a FAILURE, not a skip: a missing drift contract is how two
    // implementations get to quietly disagree about what may leave the device.
    check(false, "teach-egress-conformance.json missing or unreadable at \(teachGatePath.path)")
}

// The summary MUST stay at the very end of this file: it exits the process, so
// any check written below it never runs (that silently disabled the
// label-pattern and date checks until 2026-08-03).
print(failures == 0 ? "ALL CHECKS PASSED" : "\(failures) CHECK(S) FAILED")
exit(failures == 0 ? 0 : 1)
