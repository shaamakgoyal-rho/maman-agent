import AppKit
import ApplicationServices
import Foundation
import ObserverCore

/// THE AX HALF OF THE NATIVE BROWSER LANE.
///
/// Everything decidable lives in `BrowserActuation` (ObserverCore, mirrored
/// tests); this file is the thin glue that reads Chrome's accessibility tree
/// and performs the ONE mutating call an approved step is allowed. No key
/// events exist here — a value is set through `AXValue`, a press through
/// `AXPress`, the same channel VoiceOver uses — and secure fields are refused
/// before any read, exactly as the observer refuses to watch them.
enum BrowserActor {

    /// Chrome-family bundles this lane drives. Deliberately Chrome only for
    /// now: the mandate is "operate in the user's Chrome", and every browser
    /// added here must first prove its AX tree exposes URLs honestly.
    static let chromeBundlePrefixes = ["com.google.Chrome"]

    private static let maxNodesVisited = 6000
    private static let maxDepth = 48
    /// Bounded polls while Chromium materialises its web-content tree.
    private static let webAreaAttempts = 6

    /// Executes one contract request against the frontmost Chrome window and
    /// returns the contract's raw result object. Never throws: every failure
    /// mode is a typed refusal or a `failed` result, because the desktop end
    /// is waiting on a line that must always come.
    static func execute(requestJson: String) -> [String: Any] {
        guard let data = requestJson.data(using: .utf8),
            let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
            let requestId = request["request_id"] as? String,
            let runId = request["run_id"] as? String,
            let stepId = request["step_id"] as? String,
            let action = request["action"] as? [String: Any],
            let kind = action["kind"] as? String
        else {
            return BrowserActuation.failedResult(
                .init(requestId: "unknown", runId: "unknown", stepId: "unknown"),
                detail: "malformed browser action request")
        }
        let envelope = BrowserActuation.ResultEnvelope(
            requestId: requestId, runId: runId, stepId: stepId)
        let allowedOrigins = request["allowed_origins"] as? [String] ?? []

        if BrowserActuation.isExpired(expiresAt: request["expires_at"] as? String, now: Date()) {
            return BrowserActuation.refusedResult(
                envelope, reason: "not_authorized", resolvedName: "", matchCount: 0, origin: nil)
        }

        guard let chrome = frontmostChrome() else {
            return BrowserActuation.failedResult(
                envelope, detail: "Chrome is not running, so there is no page to act on.")
        }
        let appElement = AXUIElementCreateApplication(chrome.processIdentifier)
        // BEFORE any walk: Chromium exposes web content to AX clients only on
        // request. Skipping this is why the lane read an empty page on every
        // stock machine. See enableWebAccessibility.
        enableWebAccessibility(on: appElement)
        guard let window = focusedWindow(of: appElement) else {
            return BrowserActuation.failedResult(
                envelope, detail: "Chrome has no focused window to act on.")
        }
        if BrowserActuation.looksPrivate(windowTitle: stringAttribute(window, kAXTitleAttribute)) {
            return BrowserActuation.refusedResult(
                envelope, reason: "private_window", resolvedName: "", matchCount: 0, origin: nil)
        }
        guard let webArea = awaitWebArea(in: window) else {
            return BrowserActuation.failedResult(
                envelope,
                detail:
                    "Chrome did not expose the page to Accessibility. Grant Maman Accessibility "
                    + "access in System Settings, or pair the Chrome extension.")
        }
        guard let origin = pageOrigin(of: webArea) else {
            return BrowserActuation.failedResult(
                envelope, detail: "The page's address could not be read.")
        }
        // The page's IDENTITY is fact, the allowlist is policy — both re-checked
        // here because a queued request may outlive the tab it was aimed at.
        guard BrowserActuation.originAllowed(origin, allowedOrigins: allowedOrigins) else {
            return BrowserActuation.refusedResult(
                envelope, reason: "origin_not_allowed", resolvedName: "", matchCount: 0,
                origin: nil)
        }

        // One walk serves every verb: listing IS the discovery, and a target
        // resolves against the same snapshot it would be listed in.
        let wantedRoles: [String] =
            (action["roles"] as? [String])
            ?? (action["target"] as? [String: Any]).flatMap { $0["role"] as? String }.map { [$0] }
            ?? []
        let walk = collectControls(in: webArea, contractRoles: Set(wantedRoles))

        if kind == "list_controls" {
            let limit = min(action["limit"] as? Int ?? 60, 60)
            let listed = walk.controls.prefix(limit).map { control in
                [
                    "role": control.role,
                    "name": control.name,
                    "secure": control.secure,
                    "editable": control.editable,
                    "duplicate_count": walk.controls.filter {
                        $0.role == control.role && $0.name == control.name
                    }.count,
                ] as [String: Any]
            }
            return BrowserActuation.observedResult(
                envelope,
                observed: [
                    "resolved_name": "",
                    "match_count": walk.controls.count,
                    "origin": origin,
                    "controls": Array(listed),
                    "controls_truncated": walk.truncated || walk.controls.count > limit,
                ])
        }

        guard let target = action["target"] as? [String: Any],
            let role = target["role"] as? String,
            let name = target["name"] as? String
        else {
            return BrowserActuation.failedResult(envelope, detail: "the action names no target")
        }
        let resolution = BrowserActuation.resolve(
            controls: walk.controls, role: role, name: name, nth: target["nth"] as? Int)
        guard case let .match(control) = resolution else {
            if case let .refused(reason, matchCount) = resolution {
                return BrowserActuation.refusedResult(
                    envelope, reason: reason, resolvedName: "", matchCount: matchCount,
                    origin: origin)
            }
            return BrowserActuation.failedResult(envelope, detail: "unreachable resolution")
        }
        let element = walk.elements[control.handle]
        let currentValue = control.secure ? nil : stringAttribute(element, kAXValueAttribute)

        if let reason = BrowserActuation.refusalForAction(
            kind: kind, control: control,
            expectCurrent: action["expect_current"] as? String,
            currentValue: currentValue,
            confirmName: action["confirm_name"] as? String)
        {
            return BrowserActuation.refusedResult(
                envelope, reason: reason, resolvedName: control.name, matchCount: 1,
                origin: origin)
        }

        switch kind {
        case "read_field":
            return BrowserActuation.observedResult(
                envelope,
                observed: [
                    "resolved_name": control.name,
                    "match_count": 1,
                    "origin": origin,
                    "value_after": String((currentValue ?? "").prefix(512)),
                ])
        case "focus_field":
            let status = AXUIElementSetAttributeValue(
                element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            guard status == .success else {
                return BrowserActuation.failedResult(
                    envelope, detail: "the page refused focus (\(status.rawValue))")
            }
            return BrowserActuation.observedResult(
                envelope,
                observed: ["resolved_name": control.name, "match_count": 1, "origin": origin])
        case "set_value":
            let newValue = action["value"] as? String ?? ""
            let before = currentValue ?? ""
            let status = AXUIElementSetAttributeValue(
                element, kAXValueAttribute as CFString, newValue as CFString)
            guard status == .success else {
                return BrowserActuation.failedResult(
                    envelope, detail: "the page refused the value (\(status.rawValue))")
            }
            // Read back from the SAME element — the write's own claim of
            // success is not evidence; the field's current state is.
            let after = stringAttribute(element, kAXValueAttribute) ?? ""
            return BrowserActuation.appliedResult(
                envelope,
                observed: [
                    "resolved_name": control.name,
                    "match_count": 1,
                    "origin": origin,
                    "value_before": String(before.prefix(512)),
                    "value_after": String(after.prefix(512)),
                ])
        case "click_control":
            let status = AXUIElementPerformAction(element, kAXPressAction as CFString)
            guard status == .success else {
                return BrowserActuation.failedResult(
                    envelope, detail: "the page refused the press (\(status.rawValue))")
            }
            return BrowserActuation.appliedResult(
                envelope,
                observed: ["resolved_name": control.name, "match_count": 1, "origin": origin])
        default:
            return BrowserActuation.failedResult(
                envelope, detail: "unsupported action kind \(kind)")
        }
    }

    // ---- Chrome discovery ----

    /**
     * ASKS CHROMIUM TO BUILD ITS WEB-CONTENT ACCESSIBILITY TREE.
     *
     * Chromium keeps renderer accessibility OFF until an assistive client
     * announces itself, because building that tree costs real memory and CPU
     * per tab. Without this, `findWebArea` finds no AXWebArea (or an empty
     * one) on a stock machine and EVERY native-lane action fails with "no
     * readable page" — the lane looked implemented and could not read a single
     * control. VoiceOver users never saw it because VoiceOver already flips
     * this on.
     *
     * `AXManualAccessibility` is Chromium's own opt-in for exactly this
     * (documented for automation clients); `AXEnhancedUserInterface` is the
     * older AppKit convention some builds still honour, so both are set. The
     * tree then materialises asynchronously, which is why callers give it a
     * moment before walking.
     *
     * Idempotent and cheap: setting an already-set attribute is a no-op, so
     * this runs per action rather than needing lifecycle bookkeeping.
     */
    private static func enableWebAccessibility(on appElement: AXUIElement) {
        for attribute in ["AXManualAccessibility", "AXEnhancedUserInterface"] {
            AXUIElementSetAttributeValue(appElement, attribute as CFString, kCFBooleanTrue)
        }
    }

    /**
     * Waits briefly for the web area to appear after enabling accessibility.
     *
     * Chromium answers the request asynchronously: the first walk immediately
     * after enabling usually finds nothing. Polls a short, bounded number of
     * times rather than sleeping a fixed pessimistic interval, so a page that
     * is already instrumented costs nothing.
     */
    private static func awaitWebArea(in window: AXUIElement) -> AXUIElement? {
        for attempt in 0..<webAreaAttempts {
            if let area = findWebArea(in: window) { return area }
            // 50ms, 100ms, 150ms… bounded by webAreaAttempts.
            usleep(useconds_t(50_000 * (attempt + 1)))
        }
        return nil
    }

    private static func frontmostChrome() -> NSRunningApplication? {
        let running = NSWorkspace.shared.runningApplications.filter { app in
            guard let bundle = app.bundleIdentifier else { return false }
            return chromeBundlePrefixes.contains { bundle.hasPrefix($0) }
        }
        return running.first(where: { $0.isActive }) ?? running.first
    }

    private static func focusedWindow(of appElement: AXUIElement) -> AXUIElement? {
        var ref: CFTypeRef?
        if AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &ref)
            == .success, let window = ref as! AXUIElement?
        {
            return window
        }
        // No focused window (Chrome in the background): fall back to the main one.
        if AXUIElementCopyAttributeValue(appElement, kAXMainWindowAttribute as CFString, &ref)
            == .success, let window = ref as! AXUIElement?
        {
            return window
        }
        return nil
    }

    /// BFS for the AXWebArea — the page — under the window.
    private static func findWebArea(in window: AXUIElement) -> AXUIElement? {
        var queue: [AXUIElement] = [window]
        var visited = 0
        while !queue.isEmpty, visited < maxNodesVisited {
            let element = queue.removeFirst()
            visited += 1
            if stringAttribute(element, kAXRoleAttribute) == "AXWebArea" { return element }
            queue.append(contentsOf: children(of: element))
        }
        return nil
    }

    /// The page's own origin, from the web area's AXURL — the browser's word
    /// for where it is, not the desktop's memory of where it should be.
    private static func pageOrigin(of webArea: AXUIElement) -> String? {
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(webArea, "AXURL" as CFString, &ref) == .success
        else { return nil }
        let url: URL?
        if let cfUrl = ref as? URL {
            url = cfUrl
        } else if let text = ref as? String {
            url = URL(string: text)
        } else {
            url = nil
        }
        guard let url, let scheme = url.scheme, let host = url.host else { return nil }
        return "\(scheme)://\(host)\(url.port.map { ":\($0)" } ?? "")"
    }

    // ---- the walk ----

    private static func collectControls(
        in webArea: AXUIElement, contractRoles: Set<String>
    ) -> (controls: [BrowserActuation.PageControl], elements: [AXUIElement], truncated: Bool) {
        var controls: [BrowserActuation.PageControl] = []
        var elements: [AXUIElement] = []
        var queue: [(AXUIElement, Int)] = [(webArea, 0)]
        var visited = 0
        var truncated = false
        while !queue.isEmpty {
            if visited >= maxNodesVisited {
                truncated = true
                break
            }
            let (element, depth) = queue.removeFirst()
            visited += 1
            let axRole = stringAttribute(element, kAXRoleAttribute)
            if let contract = BrowserActuation.contractRole(axRole: axRole),
                contractRoles.isEmpty || contractRoles.contains(contract)
            {
                let name = accessibleName(of: element)
                if !name.isEmpty {
                    controls.append(
                        BrowserActuation.PageControl(
                            role: contract,
                            name: name,
                            secure: axRole == "AXSecureTextField"
                                || Redaction.isSecureRole(
                                    axRole,
                                    subrole: stringAttribute(element, kAXSubroleAttribute)),
                            editable: isEditable(element),
                            handle: elements.count
                        ))
                    elements.append(element)
                }
            }
            if depth < maxDepth {
                queue.append(contentsOf: children(of: element).map { ($0, depth + 1) })
            }
        }
        return (controls, elements, truncated)
    }

    /// Title → description → placeholder — a LABEL, never the value inside.
    private static func accessibleName(of element: AXUIElement) -> String {
        for attribute in [
            kAXTitleAttribute, kAXDescriptionAttribute, kAXPlaceholderValueAttribute,
        ] {
            if let value = stringAttribute(element, attribute), !value.isEmpty {
                return String(value.prefix(120))
            }
        }
        return ""
    }

    private static func isEditable(_ element: AXUIElement) -> Bool {
        var ref: CFTypeRef?
        if AXUIElementCopyAttributeValue(element, kAXEnabledAttribute as CFString, &ref)
            == .success, let enabled = ref as? Bool, !enabled
        {
            return false
        }
        var settable = DarwinBoolean(false)
        AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable)
        return settable.boolValue
    }

    private static func children(of element: AXUIElement) -> [AXUIElement] {
        var ref: CFTypeRef?
        guard
            AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &ref)
                == .success, let list = ref as? [AXUIElement]
        else { return [] }
        return list
    }

    private static func stringAttribute(_ element: AXUIElement, _ attribute: String) -> String? {
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &ref) == .success
        else { return nil }
        return ref as? String
    }
}
