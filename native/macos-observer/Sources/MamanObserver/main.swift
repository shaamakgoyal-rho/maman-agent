import AppKit
import ApplicationServices
import Foundation
import ObserverCore

// Maman semantic observer sidecar.
//
// Emits JSON Lines on stdout; accepts control JSON Lines on stdin.
// Observes ONLY: frontmost app changes (NSWorkspace) and AX focus/activation
// notifications for allowlisted apps. It contains no keystroke path of any
// kind (no event taps, no input monitors — enforced by CI scan), no clipboard
// reads, no screenshots outside an explicit Teach Mode session, and no
// networking of any kind.

final class ObserverRuntime {
    private var allowlistBundles: [String] = []
    private var labelPatterns: [String] = []
    /// The window we currently receive move/resize notifications for.
    private var framedWindow: AXUIElement?
    /// Last frame emitted, so a drag does not flood the pipe with duplicates.
    private var lastFrame: CGRect?
    private var privateApps: [String] = []
    private var paused = true // observe nothing until configured
    private var eventsEmitted = 0
    private var monotonicStart = DispatchTime.now()
    private var lastBoundaryReason: ObserverMessage.BoundaryReason?
    private var axObserver: AXObserver?
    private var observedPid: pid_t = 0
    private var permissionErrorEmitted = false

    private let out = FileHandle.standardOutput
    private let identity = (
        device: ProcessInfo.processInfo.environment["MAMAN_DEVICE_ID"]
            ?? "00000000-0000-7000-8000-000000000000",
        user: ProcessInfo.processInfo.environment["MAMAN_USER_ID"]
            ?? "00000000-0000-7000-8000-000000000001",
        org: ProcessInfo.processInfo.environment["MAMAN_ORG_ID"]
            ?? "00000000-0000-7000-8000-000000000002"
    )

    func emit(_ message: ObserverMessage) {
        guard let line = try? message.jsonLine() else { return }
        out.write(Data((line + "\n").utf8))
    }

    private func monotonicMs() -> Int {
        Int((DispatchTime.now().uptimeNanoseconds - monotonicStart.uptimeNanoseconds) / 1_000_000)
    }

    func start() {
        emit(.hello(
            observerVersion: "0.1.0",
            capabilities: ["macos_ax"],
            pid: ProcessInfo.processInfo.processIdentifier
        ))

        // stdin control loop on a background thread.
        DispatchQueue.global(qos: .utility).async { [weak self] in
            while let line = readLine(strippingNewline: true) {
                self?.handleControl(line: line)
            }
            // stdin closed → parent gone → exit cleanly.
            exit(0)
        }

        // Frontmost application changes.
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil,
            queue: .main
        ) { [weak self] note in
            guard let self,
                let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
            else { return }
            self.handleAppActivated(app)
        }

        // Hiding or quitting the monitored app leaves no window to dock to. Without
        // this, ⌘H on the observed app left the bar floating over an invisible
        // window — found on-device, not in tests.
        for name in [
            NSWorkspace.didHideApplicationNotification,
            NSWorkspace.didTerminateApplicationNotification,
        ] {
            NSWorkspace.shared.notificationCenter.addObserver(
                forName: name, object: nil, queue: .main
            ) { [weak self] note in
                guard let self,
                    let app = note.userInfo?[NSWorkspace.applicationUserInfoKey]
                        as? NSRunningApplication
                else { return }
                guard app.processIdentifier == self.observedPid else { return }
                self.detachAx()
            }
        }

        // Heartbeat every 30s.
        Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.emit(.heartbeat(occurredAt: isoNow(), eventsEmitted: self.eventsEmitted))
        }

        RunLoop.main.run()
    }

    private func handleControl(line: String) {
        guard let control = ObserverControl.parse(line: line) else { return }
        switch control {
        case let .configure(bundles, _, privates, patterns):
            allowlistBundles = bundles
            labelPatterns = patterns
            privateApps = privates
        case .pause: paused = true
        case .resume: paused = false
        case .teachModeStart, .teachModeStop:
            // Teach Mode shell: session management arrives with the panel flow.
            // ScreenCaptureKit is invoked ONLY from an explicit session; frames
            // stay in memory and are never written to disk.
            emit(.error(code: "teach_mode_unavailable",
                        message: "Teach Mode capture lands in a later milestone",
                        fatal: false))
        case .shutdown:
            exit(0)
        }
    }

    private func handleAppActivated(_ app: NSRunningApplication) {
        let decision = decideObservation(
            bundleId: app.bundleIdentifier,
            appName: app.localizedName,
            role: nil, subrole: nil, label: nil,
            allowlistBundles: allowlistBundles,
            privateApps: privateApps,
            paused: paused
        )
        switch decision {
        case .drop:
            lastBoundaryReason = nil
        case let .boundary(reason):
            // At most one boundary per denied context entry.
            if lastBoundaryReason != reason {
                lastBoundaryReason = reason
                emit(.boundary(reason: reason, occurredAt: isoNow()))
            }
            detachAx()
        case .emit:
            lastBoundaryReason = nil
            emitSemantic(app: app, eventType: "app_activated", role: nil, label: nil)
            attachAx(to: app)
        }
    }

    private func emitSemantic(
        app: NSRunningApplication, eventType: String, role: String?, label: String?
    ) {
        eventsEmitted += 1
        let event = SemanticEvent(
            eventId: UUID().uuidString.lowercased(),
            deviceId: identity.device,
            userId: identity.user,
            organizationId: identity.org,
            occurredAt: isoNow(),
            monotonicMs: monotonicMs(),
            app: .init(bundleId: app.bundleIdentifier, displayName: app.localizedName ?? "Unknown"),
            eventType: eventType,
            target: .init(
                role: role,
                semanticType: nil,
                stableIdHash: role.map { stableHash("\(app.bundleIdentifier ?? ""):\($0)") },
                labelHash: label.flatMap { Redaction.isSensitiveLabel($0) ? nil : stableHash($0) },
                // Same sensitivity guard as the hash: a sensitive label is never
                // pattern-matched. Only pack pattern STRINGS are emitted.
                labelPatternHits: label.flatMap { text in
                    if Redaction.isSensitiveLabel(text) { return nil }
                    let hits = matchLabelPatterns(label: text, patterns: labelPatterns)
                    return hits.isEmpty ? nil : hits
                },
                // A date is a VALUE off the user's record, so it is minimized
                // twice: the same sensitivity guard as above, and only for labels
                // that already matched a pack pattern — no pattern hit means no
                // pack workflow cares, so there is no reason to read a date at
                // all. Unusable reads (ambiguous order, two-digit year) are
                // dropped here rather than emitted for someone else to filter.
                labelDates: label.flatMap { text in
                    if Redaction.isSensitiveLabel(text) { return nil }
                    if matchLabelPatterns(label: text, patterns: labelPatterns).isEmpty {
                        return nil
                    }
                    let read = extractDateIso(text)
                    guard let date = usableDate(read) else { return nil }
                    return [SemanticEvent.Target.LabelDate(date: date, confidence: read.confidence)]
                }
            ),
            context: .init(),
            durationMs: nil,
            sensitivity: "internal",
            redaction: .init(applied: false, reasons: [])
        )
        emit(.event(event))
    }

    // ---- window geometry for the docked subtitle bar ----

    /// Frame of the monitored app's focused window, in logical points with a
    /// top-left origin (AX's own convention).
    private func focusedWindowFrame(pid: pid_t) -> CGRect? {
        let appElement = AXUIElementCreateApplication(pid)
        var windowRef: CFTypeRef?
        guard
            AXUIElementCopyAttributeValue(
                appElement, kAXFocusedWindowAttribute as CFString, &windowRef) == .success,
            let window = windowRef as! AXUIElement?
        else { return nil }
        return frame(of: window)
    }

    private func frame(of window: AXUIElement) -> CGRect? {
        var posRef: CFTypeRef?
        var sizeRef: CFTypeRef?
        guard
            AXUIElementCopyAttributeValue(window, kAXPositionAttribute as CFString, &posRef)
                == .success,
            AXUIElementCopyAttributeValue(window, kAXSizeAttribute as CFString, &sizeRef) == .success,
            let posValue = posRef as! AXValue?, let sizeValue = sizeRef as! AXValue?
        else { return nil }
        var origin = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(posValue, .cgPoint, &origin),
            AXValueGetValue(sizeValue, .cgSize, &size)
        else { return nil }
        // A zero-sized window is not something a bar can dock to.
        guard size.width > 1, size.height > 1 else { return nil }
        return CGRect(origin: origin, size: size)
    }

    /// Emits the monitored window's geometry, or a cleared frame when nothing is
    /// being monitored. Never emitted for a denied, private, or paused context —
    /// the bar must not reveal that a hard-denied window even exists.
    private func emitWindowFrame(_ rect: CGRect?) {
        if let rect, let last = lastFrame,
            abs(rect.origin.x - last.origin.x) < 2, abs(rect.origin.y - last.origin.y) < 2,
            abs(rect.width - last.width) < 2, abs(rect.height - last.height) < 2
        {
            return  // unchanged within a couple of points — nothing to say
        }
        if rect == nil && lastFrame == nil { return }
        lastFrame = rect
        let frame = rect.map {
            ObserverMessage.WindowFrame(
                x: $0.origin.x, y: $0.origin.y, width: $0.width, height: $0.height)
        }
        emit(.windowFrame(frame: frame, occurredAt: isoNow()))
    }

    /// Subscribes to move/resize on the monitored app's focused window so the bar
    /// follows a drag, not just a click.
    private func trackWindowFrames(pid: pid_t) {
        guard let observer = axObserver else { return }
        let appElement = AXUIElementCreateApplication(pid)
        var windowRef: CFTypeRef?
        guard
            AXUIElementCopyAttributeValue(
                appElement, kAXFocusedWindowAttribute as CFString, &windowRef) == .success,
            let window = windowRef as! AXUIElement?
        else {
            // The app has no focused window (an agent app, or everything hidden).
            // Returning silently here would leave the bar pinned to the PREVIOUS
            // app's rectangle — the stale-frame bug this message exists to avoid.
            framedWindow = nil
            emitWindowFrame(nil)
            return
        }
        if let old = framedWindow {
            AXObserverRemoveNotification(observer, old, kAXWindowMovedNotification as CFString)
            AXObserverRemoveNotification(observer, old, kAXWindowResizedNotification as CFString)
        }
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        AXObserverAddNotification(
            observer, window, kAXWindowMovedNotification as CFString, refcon)
        AXObserverAddNotification(
            observer, window, kAXWindowResizedNotification as CFString, refcon)
        framedWindow = window
        emitWindowFrame(frame(of: window))
    }

    // ---- AX wiring for the frontmost allowlisted app ----

    private func detachAx() {
        // Nothing is monitored any more: tell the core so the bar stops pointing
        // at a window that may no longer be there.
        framedWindow = nil
        emitWindowFrame(nil)
        if let observer = axObserver {
            CFRunLoopRemoveSource(
                CFRunLoopGetMain(),
                AXObserverGetRunLoopSource(observer),
                .defaultMode
            )
            axObserver = nil
            observedPid = 0
        }
    }

    private func attachAx(to app: NSRunningApplication) {
        guard AXIsProcessTrusted() else {
            // Never degrade silently: surface the missing permission once so the
            // Rust core and the pet can honestly show "not observing".
            if !permissionErrorEmitted {
                permissionErrorEmitted = true
                emit(.error(
                    code: "accessibility_permission_required",
                    message: "Grant Accessibility permission in System Settings to observe allowed apps.",
                    fatal: false
                ))
            }
            return
        }
        permissionErrorEmitted = false
        let pid = app.processIdentifier
        if pid == observedPid { return }
        detachAx()

        var observer: AXObserver?
        let callback: AXObserverCallback = { _, element, notification, refcon in
            guard let refcon else { return }
            let runtime = Unmanaged<ObserverRuntime>.fromOpaque(refcon).takeUnretainedValue()
            runtime.handleAxNotification(element: element, notification: notification as String)
        }
        guard AXObserverCreate(pid, callback, &observer) == .success, let observer else { return }

        let appElement = AXUIElementCreateApplication(pid)
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        for notification in [
            kAXFocusedUIElementChangedNotification,
            kAXFocusedWindowChangedNotification,
            kAXValueChangedNotification,
        ] {
            AXObserverAddNotification(observer, appElement, notification as CFString, refcon)
        }
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .defaultMode)
        axObserver = observer
        observedPid = pid
        trackWindowFrames(pid: pid)
    }

    fileprivate func handleAxNotification(element: AXUIElement, notification: String) {
        guard !paused else { return }
        guard let app = NSWorkspace.shared.frontmostApplication else { return }

        // A window move or resize is NOT workflow activity — it must never become
        // an event. It only repositions the subtitle bar, and only for a context
        // that is genuinely being observed.
        if notification == kAXWindowMovedNotification
            || notification == kAXWindowResizedNotification
        {
            let allowed = decideObservation(
                bundleId: app.bundleIdentifier, appName: app.localizedName,
                role: nil, subrole: nil, label: nil,
                allowlistBundles: allowlistBundles, privateApps: privateApps, paused: paused
            )
            if case .emit = allowed {
                emitWindowFrame(frame(of: element))
            } else {
                emitWindowFrame(nil)
            }
            return
        }

        var roleValue: CFTypeRef?
        AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &roleValue)
        let role = roleValue as? String

        var subroleValue: CFTypeRef?
        AXUIElementCopyAttributeValue(element, kAXSubroleAttribute as CFString, &subroleValue)
        let subrole = subroleValue as? String

        var titleValue: CFTypeRef?
        AXUIElementCopyAttributeValue(element, kAXTitleAttribute as CFString, &titleValue)
        let title = titleValue as? String

        let decision = decideObservation(
            bundleId: app.bundleIdentifier,
            appName: app.localizedName,
            role: role, subrole: subrole, label: title,
            allowlistBundles: allowlistBundles,
            privateApps: privateApps,
            paused: paused
        )
        switch decision {
        case .drop:
            return
        case let .boundary(reason):
            if lastBoundaryReason != reason {
                lastBoundaryReason = reason
                emit(.boundary(reason: reason, occurredAt: isoNow()))
            }
        case .emit:
            lastBoundaryReason = nil
            let eventType: String
            switch notification {
            case kAXFocusedUIElementChangedNotification: eventType = "element_focused"
            case kAXFocusedWindowChangedNotification: eventType = "window_focused"
            case kAXValueChangedNotification: eventType = "value_committed" // metadata only, never the value
            default: return
            }
            emitSemantic(app: app, eventType: eventType, role: role, label: title)
            if notification == kAXFocusedWindowChangedNotification {
                trackWindowFrames(pid: app.processIdentifier)
            } else {
                emitWindowFrame(focusedWindowFrame(pid: app.processIdentifier))
            }
        }
    }
}

ObserverRuntime().start()
