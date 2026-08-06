import Foundation

/// Swift mirror of `packages/teach-mode/src/redact.ts` — the gate every captured
/// frame passes before it may leave the device.
///
/// WHY THIS EXISTS TWICE. The TypeScript implementation is the specification and
/// carries the full test suite; but frames exist HERE, in the observer process,
/// and a gate that runs after the pixels have already crossed to another process
/// would be theater in the one place it matters. So the decision is mirrored in
/// Swift and pinned to the TS implementation by a generated fixture
/// (`domain/teach-egress-conformance.json`) asserted by both languages — the same
/// drift-contract pattern as the classifier and the date extractor. If the two
/// ever disagree, a test fails; a frame is never the messenger.
///
/// IT FAILS CLOSED. Every unknown resolves to "do not send". The cost of refusing
/// a frame is that Teach Mode learns less from that moment; the cost of the
/// opposite mistake is a password or a customer's record leaving the machine.
public enum TeachModeGate {

    /// The parts of a Teach Mode session the gate needs.
    public struct Session: Equatable, Sendable {
        public let sessionId: String
        public let maxSeconds: Int
        public let scopeBundleIds: [String]
        public init(sessionId: String, maxSeconds: Int, scopeBundleIds: [String]) {
            self.sessionId = sessionId
            self.maxSeconds = maxSeconds
            self.scopeBundleIds = scopeBundleIds
        }
    }

    /// Text the on-device OCR pass found, and where. Pixel coordinates.
    public struct TextRegion: Equatable, Sendable {
        public let text: String
        public let x: Double
        public let y: Double
        public let width: Double
        public let height: Double
        public let secure: Bool
        public init(text: String, x: Double, y: Double, width: Double, height: Double,
                    secure: Bool = false) {
            self.text = text
            self.x = x
            self.y = y
            self.width = width
            self.height = height
            self.secure = secure
        }
    }

    /// A rectangle painted over before the frame may leave, and why.
    public struct Mask: Equatable, Sendable {
        public let x: Int
        public let y: Int
        public let width: Int
        public let height: Int
        public let reason: String
        public init(x: Int, y: Int, width: Int, height: Int, reason: String) {
            self.x = x
            self.y = y
            self.width = width
            self.height = height
            self.reason = reason
        }
    }

    public struct Context: Sendable {
        public let session: Session?
        public let bundleId: String?
        public let elapsedSeconds: Double
        public let paused: Bool
        public let hardDeniedBundleIds: [String]
        public let privateBundleIds: [String]
        public let privateBrowsing: Bool
        public let secureFieldFocused: Bool
        public let textRegions: [TextRegion]
        public init(
            session: Session?, bundleId: String?, elapsedSeconds: Double, paused: Bool,
            hardDeniedBundleIds: [String], privateBundleIds: [String], privateBrowsing: Bool,
            secureFieldFocused: Bool, textRegions: [TextRegion]
        ) {
            self.session = session
            self.bundleId = bundleId
            self.elapsedSeconds = elapsedSeconds
            self.paused = paused
            self.hardDeniedBundleIds = hardDeniedBundleIds
            self.privateBundleIds = privateBundleIds
            self.privateBrowsing = privateBrowsing
            self.secureFieldFocused = secureFieldFocused
            self.textRegions = textRegions
        }
    }

    public enum Decision: Equatable, Sendable {
        case send(masks: [Mask])
        /// Refusal reason strings match the TS `EgressRefusal` union verbatim.
        case refuse(reason: String)
    }

    /// Mirror of `MAX_MASKED_FRACTION`. Comparison is strictly-greater, as in TS.
    public static let maxMaskedFraction = 0.5

    /// Mirror of contracts `SECRET_SHAPES` (common.ts) — values that look like
    /// credentials regardless of what the field is called.
    private static let secretShapes: [NSRegularExpression] = [
        regex(#"-----BEGIN [A-Z ]*PRIVATE KEY-----"#),
        regex(#"\bsk-ant-[A-Za-z0-9_-]{10,}"#),
        regex(#"\bsk_live_[A-Za-z0-9]{10,}"#),
        regex(#"\bsk-[A-Za-z0-9]{20,}"#),
        regex(#"\bAKIA[0-9A-Z]{16}\b"#),
        regex(#"\bghp_[A-Za-z0-9]{36}\b"#),
        regex(#"\bxox[baprs]-[A-Za-z0-9-]{10,}"#),
        regex(#"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b"#),  // JWT
        regex(
            #"\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[=:]\s*\S+"#,
            caseInsensitive: true),
    ]

    /// Mirror of `CREDENTIAL_LABEL` — a label that says credential even when
    /// nothing else did (a custom login form the OS never marked secure).
    private static let credentialLabel = regex(
        #"pass(word|wd|phrase)?|\bpwd\b|secret|api[\s_-]?key|token|\botp\b|\bmfa\b|2fa|auth|credential|private[\s_-]?key|seed[\s_-]?phrase|recovery[\s_-]?code|\bcvv\b|\bcvc\b|card[\s_-]?number|\bssn\b|sort[\s_-]?code|routing[\s_-]?number|\biban\b"#,
        caseInsensitive: true)

    /// Mirror of `PASSWORD_MANAGER_HINT` — injected UI that is never part of the
    /// page's own form.
    private static let passwordManagerHint = regex(
        #"1password|lastpass|bitwarden|dashlane|keeper|nordpass|keychain access|authenticator"#,
        caseInsensitive: true)

    private static func regex(_ pattern: String, caseInsensitive: Bool = false)
        -> NSRegularExpression
    {
        // Patterns are compile-time constants mirrored from TS; a typo must crash
        // the test suite loudly, not degrade the gate quietly.
        // swiftlint:disable:next force_try
        return try! NSRegularExpression(
            pattern: pattern, options: caseInsensitive ? [.caseInsensitive] : [])
    }

    private static func matches(_ re: NSRegularExpression, _ text: String) -> Bool {
        re.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }

    public static func looksLikeSecret(_ value: String) -> Bool {
        secretShapes.contains { matches($0, value) }
    }

    /// Mirror of `isCredentialish`: check order is load-bearing (the fixture pins
    /// it), because it decides which reason the audit trail records.
    private static func maskReason(for region: TextRegion) -> String? {
        if region.secure { return "secure_field" }
        if matches(passwordManagerHint, region.text) { return "password_manager_ui" }
        if looksLikeSecret(region.text) { return "secret_shaped_text" }
        if matches(credentialLabel, region.text) { return "unrecognised_credential_field" }
        return nil
    }

    /// Mirror of `maskRegionsFor`, including the geometry clamp: a zero-area mask
    /// covers nothing, and the frame would ship believing it had been redacted.
    public static func maskRegions(for regions: [TextRegion]) -> [Mask] {
        regions.compactMap { region in
            guard let reason = maskReason(for: region) else { return nil }
            return Mask(
                x: max(0, Int(region.x.rounded(.towardZero))),
                y: max(0, Int(region.y.rounded(.towardZero))),
                width: max(1, Int(region.width.rounded(.towardZero))),
                height: max(1, Int(region.height.rounded(.towardZero))),
                reason: reason)
        }
    }

    /// Mirror of `frameEgressDecision`. The check ORDER matters and is pinned by
    /// the fixture: a refusal reports the strongest reason, and a frame from a
    /// denied app is never inspected closely enough to learn anything about it.
    public static func frameEgressDecision(_ context: Context) -> Decision {
        guard let session = context.session else { return .refuse(reason: "no_session") }
        if context.elapsedSeconds >= Double(session.maxSeconds) {
            return .refuse(reason: "session_expired")
        }
        if context.paused { return .refuse(reason: "paused") }
        guard let bundleId = context.bundleId,
            !bundleId.trimmingCharacters(in: .whitespaces).isEmpty
        else { return .refuse(reason: "unknown_app") }
        if context.hardDeniedBundleIds.contains(bundleId) {
            return .refuse(reason: "hard_denied_app")
        }
        if context.privateBundleIds.contains(bundleId) {
            return .refuse(reason: "private_app")
        }
        if context.privateBrowsing { return .refuse(reason: "private_browsing") }
        if context.secureFieldFocused { return .refuse(reason: "secure_field_focused") }
        if !session.scopeBundleIds.contains(bundleId) {
            return .refuse(reason: "out_of_session_scope")
        }
        let masks = maskRegions(for: context.textRegions)
        if !context.textRegions.isEmpty,
            Double(masks.count) / Double(context.textRegions.count) > maxMaskedFraction
        {
            return .refuse(reason: "too_much_would_be_masked")
        }
        return .send(masks: masks)
    }
}
