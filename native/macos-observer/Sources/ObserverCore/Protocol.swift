import Foundation

/// Observer → core messages, mirroring `observer-protocol.ts` in
/// @maman/contracts. One JSON object per line over stdout.
public enum ObserverMessage: Encodable, Sendable {
    case hello(observerVersion: String, capabilities: [String], pid: Int32)
    case event(SemanticEvent)
    case boundary(reason: BoundaryReason, occurredAt: String)
    case heartbeat(occurredAt: String, eventsEmitted: Int)
    case error(code: String, message: String, fatal: Bool)
    /// Geometry of the window currently being monitored, so the subtitle bar can
    /// dock to it. TRANSIENT UI STATE: the Rust core never persists this and no
    /// sync projection reads it. Carries no app identity and no content — a
    /// rectangle only. `frame: nil` means "nothing is being monitored right now",
    /// which detaches the bar rather than leaving it stuck to a stale position.
    case windowFrame(frame: WindowFrame?, occurredAt: String)
    /// One MASKED Teach Mode frame, as an in-memory JPEG. The pixels ride the
    /// pipe to the Rust core exactly once and exist nowhere else: never written
    /// to disk, never logged, never persisted — the core forwards them to the
    /// vision API and drops them. Everything the gate decided (mask count, app)
    /// travels alongside as metadata.
    case teachFrame(meta: TeachFrameMeta, jpegBase64: String)
    /// Session lifecycle + per-frame refusals, so the UI can say honestly why
    /// nothing is being learned. Carries a reason string, never content.
    case teachStatus(sessionId: String, state: String, detail: String?, occurredAt: String)
    /// ONE REPLAYABLE ROUTINE, assembled by ActionTrace. Rides the same stdout
    /// line protocol as everything else, and the Rust core persists it into the
    /// LOCAL-ONLY action_traces table — never into workflow_events, and never
    /// into the sync outbox.
    case actionTrace(ActionTrace.Trace)

    /// Logical points, top-left origin — the same convention as AX and as Tauri's
    /// logical coordinates, so no conversion happens anywhere in between.
    public struct WindowFrame: Encodable, Equatable, Sendable {
        public let x: Double
        public let y: Double
        public let width: Double
        public let height: Double
        public init(x: Double, y: Double, width: Double, height: Double) {
            self.x = x
            self.y = y
            self.width = width
            self.height = height
        }
    }

    /// Metadata for one captured frame. Deliberately does NOT contain the
    /// pixels — they travel as a sibling field, never inside a reusable shape.
    public struct TeachFrameMeta: Encodable, Equatable, Sendable {
        public let frameId: String
        public let sessionId: String
        public let capturedAt: String
        public let bundleId: String
        public let width: Int
        public let height: Int
        public let maskedRegions: Int

        enum CodingKeys: String, CodingKey {
            case frameId = "frame_id", sessionId = "session_id", capturedAt = "captured_at",
                bundleId = "bundle_id", width, height, maskedRegions = "masked_regions"
        }

        public init(
            frameId: String, sessionId: String, capturedAt: String, bundleId: String,
            width: Int, height: Int, maskedRegions: Int
        ) {
            self.frameId = frameId
            self.sessionId = sessionId
            self.capturedAt = capturedAt
            self.bundleId = bundleId
            self.width = width
            self.height = height
            self.maskedRegions = maskedRegions
        }
    }

    public enum BoundaryReason: String, Encodable, Sendable {
        case hardDenied = "hard_denied"
        case secureField = "secure_field"
        case privateWindow = "private_window"
        case userPrivate = "user_private"
    }

    enum CodingKeys: String, CodingKey {
        case type, observerVersion = "observer_version", capabilities, pid, event, reason,
            occurredAt = "occurred_at", eventsEmitted = "events_emitted", code, message, fatal,
            frame, jpegBase64 = "jpeg_b64", sessionId = "session_id", state, detail, trace
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .hello(version, capabilities, pid):
            try c.encode("hello", forKey: .type)
            try c.encode(version, forKey: .observerVersion)
            try c.encode(capabilities, forKey: .capabilities)
            try c.encode(pid, forKey: .pid)
        case let .event(event):
            try c.encode("event", forKey: .type)
            try c.encode(event, forKey: .event)
        case let .boundary(reason, occurredAt):
            try c.encode("boundary", forKey: .type)
            try c.encode(reason, forKey: .reason)
            try c.encode(occurredAt, forKey: .occurredAt)
        case let .heartbeat(occurredAt, count):
            try c.encode("heartbeat", forKey: .type)
            try c.encode(occurredAt, forKey: .occurredAt)
            try c.encode(count, forKey: .eventsEmitted)
        case let .error(code, message, fatal):
            try c.encode("error", forKey: .type)
            try c.encode(code, forKey: .code)
            try c.encode(message, forKey: .message)
            try c.encode(fatal, forKey: .fatal)
        case let .windowFrame(frame, occurredAt):
            try c.encode("window_frame", forKey: .type)
            try c.encode(occurredAt, forKey: .occurredAt)
            // Explicit null rather than an omitted key: "monitoring stopped" is a
            // real state the core must act on, not an absence to be guessed at.
            try c.encode(frame, forKey: .frame)
        case let .actionTrace(trace):
            try c.encode("action_trace", forKey: .type)
            try c.encode(trace, forKey: .trace)
        case let .teachFrame(meta, jpegBase64):
            try c.encode("teach_frame", forKey: .type)
            try c.encode(meta, forKey: .frame)
            try c.encode(jpegBase64, forKey: .jpegBase64)
        case let .teachStatus(sessionId, state, detail, occurredAt):
            try c.encode("teach_status", forKey: .type)
            try c.encode(sessionId, forKey: .sessionId)
            try c.encode(state, forKey: .state)
            try c.encodeIfPresent(detail, forKey: .detail)
            try c.encode(occurredAt, forKey: .occurredAt)
        }
    }

    /// One compact JSON line (no pretty printing, stable key order not needed
    /// on the wire — the Rust core validates by schema, not by byte equality).
    public func jsonLine() throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        let data = try encoder.encode(self)
        guard let line = String(data: data, encoding: .utf8) else {
            throw ObserverError.encodingFailed
        }
        return line
    }
}

public enum ObserverError: Error {
    case encodingFailed
}

/// Core → observer control messages (stdin), one JSON object per line.
public enum ObserverControl: Equatable {
    case configure(
        allowlistBundles: [String], allowlistDomains: [String], privateApps: [String],
        labelPatterns: [String])
    case pause
    case resume
    case teachModeStart(sessionId: String, maxSeconds: Int, scopeBundleIds: [String])
    case teachModeStop
    case shutdown
    /// One browser action to execute against the live Chrome AX tree — the
    /// native lane that replaces the extension as a REQUIREMENT. The request
    /// is carried as its canonical JSON string: the executable re-parses it
    /// (the desktop's serialization is data here, like everything on stdin)
    /// and answers with a `browser_action_result` line.
    case browserAction(requestJson: String)

    public static func parse(line: String) -> ObserverControl? {
        guard let data = line.data(using: .utf8),
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let type = json["type"] as? String
        else { return nil }
        switch type {
        case "configure":
            return .configure(
                allowlistBundles: json["allowlist_bundles"] as? [String] ?? [],
                allowlistDomains: json["allowlist_domains"] as? [String] ?? [],
                privateApps: json["private_apps"] as? [String] ?? [],
                labelPatterns: json["label_patterns"] as? [String] ?? []
            )
        case "pause": return .pause
        case "resume": return .resume
        case "teach_mode_start":
            // ALL of these are required. A start without a session id cannot be
            // correlated; one without scope would make starting a session consent
            // to film everything — refusing to parse is the fail-closed answer.
            guard let max = json["max_seconds"] as? Int, max >= 1, max <= 900,
                let sessionId = json["session_id"] as? String, !sessionId.isEmpty,
                let scope = json["scope_bundle_ids"] as? [String], !scope.isEmpty
            else { return nil }
            return .teachModeStart(sessionId: sessionId, maxSeconds: max, scopeBundleIds: scope)
        case "teach_mode_stop": return .teachModeStop
        case "shutdown": return .shutdown
        case "browser_action":
            // The request must at least be an object carrying a request_id, or
            // no answer could ever be correlated — refuse to parse instead.
            guard let request = json["request"] as? [String: Any],
                request["request_id"] as? String != nil,
                let data = try? JSONSerialization.data(withJSONObject: request),
                let requestJson = String(data: data, encoding: .utf8)
            else { return nil }
            return .browserAction(requestJson: requestJson)
        default: return nil
        }
    }
}

/// ISO 8601 UTC with milliseconds.
public func isoNow(_ date: Date = Date()) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
}
