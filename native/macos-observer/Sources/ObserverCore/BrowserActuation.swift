import Foundation

/// THE NATIVE BROWSER LANE — the decisions, with no AX in sight.
///
/// Maman must not depend on a browser extension: it acts inside the user's real
/// Chrome through the SAME Accessibility tree it already observes, with the
/// same permission the user already granted. This module is the pure half of
/// that lane: role vocabulary, target resolution, refusal decisions, and the
/// wire shape of a result. The executable's `BrowserActor` supplies the actual
/// AX tree as plain `PageControl` values and performs the one mutating call;
/// everything that can be wrong lives here, where the mirrored test runner can
/// prove it without a browser.
///
/// Trust model, stated plainly: requests arrive over the sidecar's OWN stdin,
/// which only the desktop process holds — there is no third party on this
/// channel the way there was a native-messaging host on the extension's, so
/// there is no signature to verify. What this lane still re-checks for itself,
/// because the desktop's word is policy and the PAGE's identity is fact:
/// the tab's origin against `allowed_origins`, secure fields, private windows,
/// and the request's expiry (a stale request from a queue is not a live intent).
public enum BrowserActuation {

    /// One control as the AX walk found it — role already translated to the
    /// contract vocabulary, name already resolved, nothing else retained.
    public struct PageControl: Equatable, Sendable {
        public let role: String
        public let name: String
        public let secure: Bool
        public let editable: Bool
        /// Index into the executable's parallel AXUIElement array.
        public let handle: Int

        public init(role: String, name: String, secure: Bool, editable: Bool, handle: Int) {
            self.role = role
            self.name = name
            self.secure = secure
            self.editable = editable
            self.handle = handle
        }
    }

    /// Contract role → the AX roles that mean it. The reverse of what the
    /// semantic observer does, kept as ONE table so the two directions cannot
    /// drift apart control by control.
    public static let axRolesByContractRole: [String: [String]] = [
        "textbox": ["AXTextField", "AXTextArea", "AXSearchField"],
        "combobox": ["AXComboBox", "AXPopUpButton"],
        "checkbox": ["AXCheckBox"],
        "button": ["AXButton"],
        "link": ["AXLink"],
        "cell": ["AXCell"],
        "heading": ["AXHeading"],
    ]

    /// AX role (+ secure subrole) → contract role, or nil for roles the
    /// contract has no word for (those are never listed, never targets).
    public static func contractRole(axRole: String?) -> String? {
        guard let axRole else { return nil }
        if axRole == "AXSecureTextField" { return "textbox" }
        for (contract, axRoles) in axRolesByContractRole where axRoles.contains(axRole) {
            return contract
        }
        return nil
    }

    /// Resolves role+name(+nth) against the walked controls — the same
    /// exact-name rule as the extension's DOM adapter, so an agent compiled
    /// against one lane resolves identically on the other.
    public enum Resolution: Equatable {
        case match(PageControl)
        case refused(reason: String, matchCount: Int)
    }

    public static func resolve(
        controls: [PageControl], role: String, name: String, nth: Int?
    ) -> Resolution {
        let hits = controls.filter { $0.role == role && $0.name == name }
        if hits.isEmpty { return .refused(reason: "no_match", matchCount: 0) }
        if let nth {
            guard nth >= 1, nth <= hits.count else {
                return .refused(reason: "no_match", matchCount: hits.count)
            }
            return .match(hits[nth - 1])
        }
        if hits.count > 1 { return .refused(reason: "ambiguous_match", matchCount: hits.count) }
        return .match(hits[0])
    }

    /// Every gate a resolved WRITE-ish action passes before anything mutates.
    /// Reads share the secure-field rule; the contract's executor already
    /// decided writes-vs-reads policy on the desktop, so this is the page-side
    /// re-check, not a second policy engine.
    public static func refusalForAction(
        kind: String, control: PageControl, expectCurrent: String?, currentValue: String?,
        confirmName: String?
    ) -> String? {
        if control.secure || Redaction.isSensitiveLabel(control.name) { return "secure_field" }
        switch kind {
        case "read_field", "focus_field":
            return nil
        case "set_value":
            if !control.editable { return "target_not_editable" }
            if let expectCurrent, expectCurrent != (currentValue ?? "") {
                return "precondition_failed"
            }
            return nil
        case "click_control":
            // The name the user approved must be the name the page resolves
            // NOW — a relabelled button is a different action.
            if let confirmName, confirmName != control.name { return "confirm_name_mismatch" }
            return nil
        default:
            return nil
        }
    }

    /// Origin gate: exact origin, or a subdomain of an allowed HOST — the same
    /// rule as the Rust ingest allowlist, refusing the lookalike suffixes.
    public static func originAllowed(_ origin: String, allowedOrigins: [String]) -> Bool {
        allowedOrigins.contains { allowed in
            if origin == allowed { return true }
            guard let allowedHost = URL(string: allowed)?.host,
                let originHost = URL(string: origin)?.host,
                URL(string: origin)?.scheme == "https"
            else { return false }
            return originHost == allowedHost || originHost.hasSuffix(".\(allowedHost)")
        }
    }

    /// A queued request that expired in the queue is refused, not executed:
    /// `expires_at` was the desktop's own promise about how long the intent
    /// stays live.
    public static func isExpired(expiresAt: String?, now: Date) -> Bool {
        guard let expiresAt else { return true }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let parsed =
            formatter.date(from: expiresAt)
            ?? {
                formatter.formatOptions = [.withInternetDateTime]
                return formatter.date(from: expiresAt)
            }()
        guard let deadline = parsed else { return true }
        return now > deadline
    }

    /// Chrome's incognito windows say so in the title. Locale-dependent, so the
    /// list is deliberately broad; a false positive refuses actuation, which is
    /// the safe direction to be wrong in.
    public static func looksPrivate(windowTitle: String?) -> Bool {
        guard let windowTitle else { return false }
        let lower = windowTitle.lowercased()
        return lower.contains("incognito") || lower.contains("private browsing")
            || lower.contains("(private)")
    }

    // ---- result construction: the contract's RAW shape, one builder ----

    /// The fields every result carries, echoed from the request.
    public struct ResultEnvelope: Sendable {
        public let requestId: String
        public let runId: String
        public let stepId: String

        public init(requestId: String, runId: String, stepId: String) {
            self.requestId = requestId
            self.runId = runId
            self.stepId = stepId
        }
    }

    private static func base(_ e: ResultEnvelope, outcome: String) -> [String: Any] {
        [
            "schema_version": 1,
            "type": "browser_action_result",
            "request_id": e.requestId,
            "run_id": e.runId,
            "step_id": e.stepId,
            "outcome": outcome,
            "completed_at": isoNow8601(),
        ]
    }

    public static func refusedResult(
        _ e: ResultEnvelope, reason: String, resolvedName: String, matchCount: Int, origin: String?
    ) -> [String: Any] {
        var result = base(e, outcome: "refused")
        result["refusal_reason"] = reason
        if let origin {
            result["observed"] = [
                "resolved_name": resolvedName, "match_count": matchCount, "origin": origin,
            ]
        }
        return result
    }

    public static func failedResult(_ e: ResultEnvelope, detail: String) -> [String: Any] {
        var result = base(e, outcome: "failed")
        result["failure"] = String(detail.prefix(200))
        return result
    }

    public static func observedResult(
        _ e: ResultEnvelope, observed: [String: Any]
    ) -> [String: Any] {
        var result = base(e, outcome: "observed")
        result["observed"] = observed
        return result
    }

    public static func appliedResult(
        _ e: ResultEnvelope, observed: [String: Any]
    ) -> [String: Any] {
        var result = base(e, outcome: "applied")
        result["observed"] = observed
        return result
    }

    private static func isoNow8601() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date())
    }
}
