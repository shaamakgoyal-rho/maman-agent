import AppKit
import ApplicationServices
import CoreGraphics
import CryptoKit
import Foundation
import ImageIO
import ObserverCore
import ScreenCaptureKit
import UniformTypeIdentifiers
import Vision

/// Teach Mode capture: the only code in this product that reads pixels.
///
/// Everything here is bounded by an explicit session the user started, and every
/// frame passes `TeachModeGate.frameEgressDecision` — the Swift mirror of the TS
/// specification, pinned by `domain/teach-egress-conformance.json` — before its
/// bytes may leave this process. Structural properties, not policy:
///
/// - CAPTURE IS PER-WINDOW, not per-display. `SCContentFilter(desktopIndependent-
///   Window:)` means pixels of other apps, other windows and the desktop never
///   enter the buffer at all — a stronger guarantee than masking them out after.
/// - FRAMES LIVE IN MEMORY ONLY. Nothing here takes a file path; the JPEG goes
///   out on stdout to the Rust core (device-local pipe) and is dropped.
/// - THIS PROCESS STILL HAS NO NETWORK CODE. ScreenCaptureKit, Vision, ImageIO —
///   all local frameworks. The egress to the vision API happens in the Rust core,
///   which is where every HTTP request in this product originates.
/// - MASKING HAPPENS AT FULL RESOLUTION, before the frame is downscaled for
///   transport, so a mask cannot land on the wrong pixels through rounding.
// @unchecked because the compiler cannot see the discipline: every mutable
// property is read and written on the main thread only — the capture Task does
// pure work (screenshot, OCR, gate, encode) and hops back to main to touch state.
final class TeachModeCapture: @unchecked Sendable {
    /// The whole point of a cadence this slow is that Teach Mode is a person
    /// demonstrating a workflow, not a video feed: 2.5s catches every meaningful
    /// state change a form-filling workflow has, at a fraction of the vision cost.
    private static let cadenceSeconds: TimeInterval = 2.5
    /// Longest dimension of a frame on the wire. Enough for the model to read
    /// ordinary UI text; small enough to keep per-frame cost sane.
    private static let maxTransportDimension = 1400

    private let emit: (ObserverMessage) -> Void
    /// Live observer state the gate needs: paused + user-private apps (which
    /// already include Maman's own bundle id, appended by the Rust core).
    private let state: () -> (paused: Bool, privateApps: [String])

    private var session: TeachModeGate.Session?
    private var startedAt = Date()
    private var timer: Timer?
    private var captureInFlight = false
    private var lastRefusalReason: String?
    private var lastFrameDigest: String?

    init(
        emit: @escaping (ObserverMessage) -> Void,
        state: @escaping () -> (paused: Bool, privateApps: [String])
    ) {
        self.emit = emit
        self.state = state
    }

    // MARK: session lifecycle

    /// Whether this process has connected to the window server yet.
    private static var windowServerReady = false

    /// Connects to the window server, once, before any ScreenCaptureKit call.
    ///
    /// FOUND BY RUNNING IT: the sidecar is a plain CLI process, and the first real
    /// capture died on `Assertion failed: (did_initialize), CGS_REQUIRE_INIT` —
    /// CoreGraphics' window-server APIs are unavailable to a process that never
    /// initialised Cocoa. `CGPreflightScreenCaptureAccess` succeeded first, so the
    /// session reported "started" and then the process vanished mid-capture,
    /// emitting neither a frame nor a refusal nor its own time-box end. Nothing in
    /// the type system or the test suite could have caught that.
    ///
    /// Done LAZILY, on the first session, so the ordinary AX-only observer keeps
    /// exactly the process shape it had. `.prohibited` keeps the sidecar out of the
    /// Dock and the app switcher — it is not an app the user should see.
    private static func ensureWindowServerConnection() {
        guard !windowServerReady else { return }
        windowServerReady = true
        // `NSApplication.shared` is the Swift-visible way to create the app object
        // and connect to the window server (`NSApplicationLoad` is C-only and not
        // in scope here — trying it first produced a build error, which meant a
        // stale binary kept reproducing the original crash and briefly made the fix
        // look ineffective).
        NSApplication.shared.setActivationPolicy(.prohibited)
    }

    func start(sessionId: String, maxSeconds: Int, scopeBundleIds: [String]) {
        // One session at a time; a new start replaces a stale one explicitly.
        stopInternal(detail: session == nil ? nil : "replaced_by_new_session")

        Self.ensureWindowServerConnection()

        // Screen Recording is macOS's grant to make, not ours. Refuse honestly
        // rather than capturing black frames, which is what an ungranted
        // ScreenCaptureKit silently produces.
        guard CGPreflightScreenCaptureAccess() else {
            CGRequestScreenCaptureAccess()  // surfaces the system prompt once
            emit(.error(
                code: "screen_recording_permission_required",
                message: "Grant Screen Recording in System Settings to use Teach Mode.",
                fatal: false))
            emit(.teachStatus(
                sessionId: sessionId, state: "refused",
                detail: "screen_recording_permission_required", occurredAt: isoNow()))
            return
        }

        session = TeachModeGate.Session(
            sessionId: sessionId, maxSeconds: maxSeconds, scopeBundleIds: scopeBundleIds)
        startedAt = Date()
        lastRefusalReason = nil
        lastFrameDigest = nil
        emit(.teachStatus(sessionId: sessionId, state: "started", detail: nil, occurredAt: isoNow()))

        let timer = Timer(timeInterval: Self.cadenceSeconds, repeats: true) { [weak self] _ in
            self?.tick()
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    func stop() {
        stopInternal(detail: "stopped")
    }

    private func stopInternal(detail: String?) {
        timer?.invalidate()
        timer = nil
        if let session, let detail {
            emit(.teachStatus(
                sessionId: session.sessionId, state: "ended", detail: detail,
                occurredAt: isoNow()))
        }
        session = nil
    }

    // MARK: per-tick capture

    private func tick() {
        guard let session else { return }

        // The box is self-terminating; the timer enforces it even if the core
        // never sends a stop.
        let elapsed = Date().timeIntervalSince(startedAt)
        if elapsed >= Double(session.maxSeconds) {
            stopInternal(detail: "time_box_elapsed")
            return
        }
        // A capture can outlive one tick (OCR on a large window); never stack them.
        guard !captureInFlight else { return }

        let observerState = state()
        let front = NSWorkspace.shared.frontmostApplication
        let bundleId = front?.bundleIdentifier
        let appName = front?.localizedName

        // Fast pre-gate on everything knowable WITHOUT touching pixels. A frame
        // from a denied context is refused before any capture happens at all.
        let preContext = gateContext(
            session: session, elapsed: elapsed, bundleId: bundleId, appName: appName,
            observerState: observerState, textRegions: [])
        if case let .refuse(reason) = TeachModeGate.frameEgressDecision(preContext) {
            reportRefusal(session: session, reason: reason)
            return
        }

        guard let pid = front?.processIdentifier, let bundleId else { return }
        captureInFlight = true
        Task { [weak self] in
            await self?.captureOnce(
                session: session, elapsed: elapsed, pid: pid, bundleId: bundleId,
                appName: appName, observerState: observerState)
            DispatchQueue.main.async { self?.captureInFlight = false }
        }
    }

    private func captureOnce(
        session: TeachModeGate.Session, elapsed: TimeInterval, pid: pid_t, bundleId: String,
        appName: String?, observerState: (paused: Bool, privateApps: [String])
    ) async {
        // Per-window filter: only the demonstrated app's frontmost window exists
        // in the buffer. Other windows are not masked — they are never captured.
        guard
            let content = try? await SCShareableContent.excludingDesktopWindows(
                true, onScreenWindowsOnly: true),
            let window = content.windows
                .filter({ $0.owningApplication?.processID == pid && $0.isOnScreen })
                .max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height })
        else {
            reportRefusal(session: session, reason: "window_unavailable")
            return
        }

        let configuration = SCStreamConfiguration()
        // Capture at 2x the window's point size (Retina) so OCR reads real text,
        // capped for sanity; the transport downscale happens after masking.
        let scale = 2.0
        configuration.width = min(Int(window.frame.width * scale), 3200)
        configuration.height = min(Int(window.frame.height * scale), 3200)
        configuration.showsCursor = false

        guard
            let image = try? await SCScreenshotManager.captureImage(
                contentFilter: SCContentFilter(desktopIndependentWindow: window),
                configuration: configuration)
        else {
            reportRefusal(session: session, reason: "capture_failed")
            return
        }

        let regions = recognizeText(in: image)

        // The FULL gate, now with what the OCR pass read. Everything it decides —
        // including refusing the whole frame — happens before any byte leaves.
        let context = gateContext(
            session: session, elapsed: elapsed, bundleId: bundleId, appName: appName,
            observerState: observerState, textRegions: regions)
        let masks: [TeachModeGate.Mask]
        switch TeachModeGate.frameEgressDecision(context) {
        case let .refuse(reason):
            reportRefusal(session: session, reason: reason)
            return
        case let .send(m):
            masks = m
        }

        guard let jpeg = maskScaleAndEncode(image: image, masks: masks) else {
            reportRefusal(session: session, reason: "encode_failed")
            return
        }

        let digest = SHA256.hash(data: jpeg.data).map { String(format: "%02x", $0) }.joined()
        let meta = ObserverMessage.TeachFrameMeta(
            frameId: UUID().uuidString.lowercased(),
            sessionId: session.sessionId,
            capturedAt: isoNow(),
            bundleId: bundleId,
            width: jpeg.width,
            height: jpeg.height,
            maskedRegions: masks.count)
        let line = ObserverMessage.teachFrame(
            meta: meta, jpegBase64: jpeg.data.base64EncodedString())
        // State mutation and emission both happen on main: dedupe compare-and-set
        // must not race the next tick.
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            // A frame identical to the last one teaches nothing and costs a full
            // vision call; drop it here.
            if digest == self.lastFrameDigest { return }
            self.lastFrameDigest = digest
            self.lastRefusalReason = nil
            self.emit(line)
        }
    }

    // MARK: gate context assembly

    private func gateContext(
        session: TeachModeGate.Session, elapsed: TimeInterval, bundleId: String?,
        appName: String?, observerState: (paused: Bool, privateApps: [String]),
        textRegions: [TeachModeGate.TextRegion]
    ) -> TeachModeGate.Context {
        // The gate compares exact bundle ids (fixture-pinned); the observer's
        // broader substring matching is applied HERE, by pre-expanding membership.
        let hardDenied =
            Redaction.isHardDeniedApp(bundleId: bundleId, name: appName)
            ? [bundleId ?? ""] : []
        let userPrivate =
            Redaction.isUserPrivateApp(
                bundleId: bundleId, name: appName, privateApps: observerState.privateApps)
            ? [bundleId ?? ""] : []
        return TeachModeGate.Context(
            session: session,
            bundleId: bundleId,
            elapsedSeconds: elapsed,
            paused: observerState.paused,
            hardDeniedBundleIds: hardDenied,
            privateBundleIds: userPrivate,
            privateBrowsing: frontWindowLooksPrivate(),
            secureFieldFocused: focusedElementIsSecure(),
            textRegions: textRegions)
    }

    /// A secure input anywhere with keyboard focus withholds the whole frame.
    private func focusedElementIsSecure() -> Bool {
        let systemWide = AXUIElementCreateSystemWide()
        var focusedRef: CFTypeRef?
        guard
            AXUIElementCopyAttributeValue(
                systemWide, kAXFocusedUIElementAttribute as CFString, &focusedRef) == .success,
            let focused = focusedRef as! AXUIElement?
        else { return false }
        var roleRef: CFTypeRef?
        var subroleRef: CFTypeRef?
        AXUIElementCopyAttributeValue(focused, kAXRoleAttribute as CFString, &roleRef)
        AXUIElementCopyAttributeValue(focused, kAXSubroleAttribute as CFString, &subroleRef)
        return Redaction.isSecureRole(roleRef as? String, subrole: subroleRef as? String)
    }

    /// Best-effort incognito detection from the focused window's AX title. The
    /// title is inspected INSIDE this process, used only to refuse, and never
    /// emitted. A floor, not a proof — browsers that mark private windows do so
    /// in the title; one that does not is covered only by the user's allowlist.
    private func frontWindowLooksPrivate() -> Bool {
        guard let front = NSWorkspace.shared.frontmostApplication else { return false }
        let appElement = AXUIElementCreateApplication(front.processIdentifier)
        var windowRef: CFTypeRef?
        guard
            AXUIElementCopyAttributeValue(
                appElement, kAXFocusedWindowAttribute as CFString, &windowRef) == .success,
            let window = windowRef as! AXUIElement?
        else { return false }
        var titleRef: CFTypeRef?
        AXUIElementCopyAttributeValue(window, kAXTitleAttribute as CFString, &titleRef)
        guard let title = (titleRef as? String)?.lowercased() else { return false }
        return title.contains("incognito") || title.contains("private browsing")
            || title.contains("(private)") || title.contains("inprivate")
    }

    // MARK: OCR

    /// On-device text recognition feeding the mask decision. Vision's normalized
    /// bottom-left boxes are converted to the top-left pixel coordinates the gate
    /// (and its fixture) use.
    private func recognizeText(in image: CGImage) -> [TeachModeGate.TextRegion] {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        guard (try? handler.perform([request])) != nil,
            let observations = request.results
        else { return [] }
        let width = Double(image.width)
        let height = Double(image.height)
        return observations.compactMap { observation in
            guard let text = observation.topCandidates(1).first?.string else { return nil }
            let box = observation.boundingBox
            return TeachModeGate.TextRegion(
                text: text,
                x: box.minX * width,
                y: (1.0 - box.maxY) * height,
                width: box.width * width,
                height: box.height * height,
                secure: false)
        }
    }

    // MARK: masking + encoding

    /// Paints the masks at FULL resolution, then downscales for transport, then
    /// encodes JPEG — all in memory. Returns nil only on CoreGraphics failure.
    private func maskScaleAndEncode(image: CGImage, masks: [TeachModeGate.Mask])
        -> (data: Data, width: Int, height: Int)?
    {
        let fullWidth = image.width
        let fullHeight = image.height
        guard
            let masked = CGContext(
                data: nil, width: fullWidth, height: fullHeight, bitsPerComponent: 8,
                bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { return nil }
        masked.draw(image, in: CGRect(x: 0, y: 0, width: fullWidth, height: fullHeight))
        masked.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
        for mask in masks {
            // Gate coordinates are top-left origin; CoreGraphics draws bottom-left.
            // A small bleed around each mask absorbs OCR box imprecision — a mask
            // that is a few pixels too big costs nothing.
            let bleed = 4
            let rect = CGRect(
                x: mask.x - bleed,
                y: fullHeight - (mask.y + mask.height) - bleed,
                width: mask.width + 2 * bleed,
                height: mask.height + 2 * bleed)
            masked.fill(rect)
        }
        guard let maskedImage = masked.makeImage() else { return nil }

        let longest = max(fullWidth, fullHeight)
        let ratio = min(1.0, Double(Self.maxTransportDimension) / Double(longest))
        let outWidth = max(1, Int(Double(fullWidth) * ratio))
        let outHeight = max(1, Int(Double(fullHeight) * ratio))
        guard
            let scaled = CGContext(
                data: nil, width: outWidth, height: outHeight, bitsPerComponent: 8,
                bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { return nil }
        scaled.interpolationQuality = .high
        scaled.draw(maskedImage, in: CGRect(x: 0, y: 0, width: outWidth, height: outHeight))
        guard let outImage = scaled.makeImage() else { return nil }

        let data = NSMutableData()
        guard
            let destination = CGImageDestinationCreateWithData(
                data as CFMutableData, UTType.jpeg.identifier as CFString, 1, nil)
        else { return nil }
        CGImageDestinationAddImage(
            destination, outImage,
            [kCGImageDestinationLossyCompressionQuality: 0.6] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return (data as Data, outWidth, outHeight)
    }

    // MARK: status reporting

    /// One line per refusal-reason CHANGE, not per tick — the UI needs "why is
    /// nothing being learned", not a drumbeat.
    private func reportRefusal(session: TeachModeGate.Session, reason: String) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            guard reason != self.lastRefusalReason else { return }
            self.lastRefusalReason = reason
            self.emit(
                .teachStatus(
                    sessionId: session.sessionId, state: "frame_refused", detail: reason,
                    occurredAt: isoNow()))
        }
    }
}
