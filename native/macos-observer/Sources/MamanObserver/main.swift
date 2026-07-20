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
        case let .configure(bundles, _, privates):
            allowlistBundles = bundles
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
                labelHash: label.flatMap { Redaction.isSensitiveLabel($0) ? nil : stableHash($0) }
            ),
            context: .init(),
            durationMs: nil,
            sensitivity: "internal",
            redaction: .init(applied: false, reasons: [])
        )
        emit(.event(event))
    }

    // ---- AX wiring for the frontmost allowlisted app ----

    private func detachAx() {
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
    }

    fileprivate func handleAxNotification(element: AXUIElement, notification: String) {
        guard !paused else { return }
        guard let app = NSWorkspace.shared.frontmostApplication else { return }

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
        }
    }
}

ObserverRuntime().start()
