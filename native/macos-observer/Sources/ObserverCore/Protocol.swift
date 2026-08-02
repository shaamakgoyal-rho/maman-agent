import Foundation

/// Observer → core messages, mirroring `observer-protocol.ts` in
/// @maman/contracts. One JSON object per line over stdout.
public enum ObserverMessage: Encodable {
    case hello(observerVersion: String, capabilities: [String], pid: Int32)
    case event(SemanticEvent)
    case boundary(reason: BoundaryReason, occurredAt: String)
    case heartbeat(occurredAt: String, eventsEmitted: Int)
    case error(code: String, message: String, fatal: Bool)

    public enum BoundaryReason: String, Encodable {
        case hardDenied = "hard_denied"
        case secureField = "secure_field"
        case privateWindow = "private_window"
        case userPrivate = "user_private"
    }

    enum CodingKeys: String, CodingKey {
        case type, observerVersion = "observer_version", capabilities, pid, event, reason,
            occurredAt = "occurred_at", eventsEmitted = "events_emitted", code, message, fatal
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
    case teachModeStart(maxSeconds: Int)
    case teachModeStop
    case shutdown

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
            guard let max = json["max_seconds"] as? Int, max >= 1, max <= 900 else { return nil }
            return .teachModeStart(maxSeconds: max)
        case "teach_mode_stop": return .teachModeStop
        case "shutdown": return .shutdown
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
