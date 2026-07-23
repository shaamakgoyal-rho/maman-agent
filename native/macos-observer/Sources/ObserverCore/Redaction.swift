import Foundation

/// Source-side redaction (defense layer 1; the Rust core re-checks).
/// The observer NEVER registers keyboard event taps — this module only decides
/// what may be emitted from AX notifications it already receives.
public enum Redaction {

    /// AX roles/subroles that must never produce content events.
    public static let secureRoles: Set<String> = [
        "AXSecureTextField"
    ]

    /// Substrings identifying fields that must never be observed.
    public static let sensitiveFieldMarkers: [String] = [
        "password", "passwd", "secret", "api key", "api_key", "token", "otp",
        "one-time", "one time code", "cvv", "cvc", "card number", "ssn",
        "social security", "bank", "routing number", "iban",
    ]

    /// Hard-denied application bundle prefixes and names (mirrors Rust list).
    public static let hardDeniedApps: [String] = [
        "com.1password", "com.lastpass", "com.bitwarden", "com.dashlane",
        "com.apple.keychainaccess", "com.apple.loginwindow", "com.apple.securityagent",
        "1password", "lastpass", "bitwarden", "keychain access",
    ]

    public static func isSecureRole(_ role: String?, subrole: String? = nil) -> Bool {
        if let role, secureRoles.contains(role) { return true }
        if let subrole, secureRoles.contains(subrole) { return true }
        return false
    }

    public static func isSensitiveLabel(_ label: String?) -> Bool {
        guard let label else { return false }
        let lower = label.lowercased()
        return sensitiveFieldMarkers.contains { lower.contains($0) }
    }

    public static func isHardDeniedApp(bundleId: String?, name: String?) -> Bool {
        let hay = "\(bundleId?.lowercased() ?? "") \(name?.lowercased() ?? "")"
        return hardDeniedApps.contains { hay.contains($0) }
    }

    public static func isUserPrivateApp(
        bundleId: String?, name: String?, privateApps: [String]
    ) -> Bool {
        let hay = "\(bundleId?.lowercased() ?? "") \(name?.lowercased() ?? "")"
        return privateApps.contains { !$0.isEmpty && hay.contains($0.lowercased()) }
    }

    /// Allowlist check: nothing is observed unless the app was allowed. A single
    /// "*" entry means "observe every app" (the user's explicit opt-in) — the
    /// hard-deny, user-private, and secure-field boundaries in decideObservation
    /// run BEFORE this, so sensitive contexts are still never observed.
    public static func isAllowlisted(bundleId: String?, allowlistBundles: [String]) -> Bool {
        if allowlistBundles.contains("*") { return true }
        guard let bundleId else { return false }
        let lower = bundleId.lowercased()
        return allowlistBundles.contains { lower == $0.lowercased() }
    }
}

/// Decision for one AX notification.
public enum ObservationDecision: Equatable {
    case emit
    case boundary(ObserverMessage.BoundaryReason)
    case drop
}

/// Central per-notification gate used by the executable.
public func decideObservation(
    bundleId: String?,
    appName: String?,
    role: String?,
    subrole: String?,
    label: String?,
    allowlistBundles: [String],
    privateApps: [String],
    paused: Bool
) -> ObservationDecision {
    if paused { return .drop }
    if Redaction.isHardDeniedApp(bundleId: bundleId, name: appName) {
        return .boundary(.hardDenied)
    }
    if Redaction.isUserPrivateApp(bundleId: bundleId, name: appName, privateApps: privateApps) {
        return .boundary(.userPrivate)
    }
    if !Redaction.isAllowlisted(bundleId: bundleId, allowlistBundles: allowlistBundles) {
        return .drop
    }
    if Redaction.isSecureRole(role, subrole: subrole) || Redaction.isSensitiveLabel(label) {
        return .boundary(.secureField)
    }
    return .emit
}
