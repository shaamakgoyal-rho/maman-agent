import Foundation
import CryptoKit

/// The WorkflowEvent shape the observer emits (subset builder — the Rust core
/// re-validates against the full schema before persistence).
public struct SemanticEvent: Encodable {
    public let schemaVersion = 1
    public var eventId: String
    public var deviceId: String
    public var userId: String
    public var organizationId: String
    public var occurredAt: String
    public var monotonicMs: Int
    public var source = "macos_ax"
    public var app: App
    public var eventType: String
    public var target: Target
    public var context: Context
    public var durationMs: Int?
    public var sensitivity: String
    public var redaction: Redaction

    public struct App: Encodable {
        public var bundleId: String?
        public var displayName: String
        enum CodingKeys: String, CodingKey {
            case bundleId = "bundle_id", displayName = "display_name"
        }
        public init(bundleId: String?, displayName: String) {
            self.bundleId = bundleId
            self.displayName = displayName
        }
    }
    public struct Target: Encodable {
        public var role: String?
        public var semanticType: String?
        public var stableIdHash: String?
        public var labelHash: String?
        /// Pack label-pattern strings that matched the (pre-hash) label — pack
        /// constants only, never label text. See LabelPatterns.swift.
        public var labelPatternHits: [String]?
        enum CodingKeys: String, CodingKey {
            case role, semanticType = "semantic_type", stableIdHash = "stable_id_hash",
                labelHash = "label_hash", labelPatternHits = "label_pattern_hits"
        }
        public init(
            role: String?, semanticType: String?, stableIdHash: String?, labelHash: String?,
            labelPatternHits: [String]? = nil
        ) {
            self.role = role
            self.semanticType = semanticType
            self.stableIdHash = stableIdHash
            self.labelHash = labelHash
            self.labelPatternHits = labelPatternHits
        }
    }
    public struct Context: Encodable {
        public var pageType: String?
        public var objectType: String?
        enum CodingKeys: String, CodingKey {
            case pageType = "page_type", objectType = "object_type"
        }
        public init(pageType: String? = nil, objectType: String? = nil) {
            self.pageType = pageType
            self.objectType = objectType
        }
    }
    public struct Redaction: Encodable {
        public var applied: Bool
        public var reasons: [String]
        public init(applied: Bool, reasons: [String]) {
            self.applied = applied
            self.reasons = reasons
        }
    }

    enum CodingKeys: String, CodingKey {
        case schemaVersion = "schema_version", eventId = "event_id", deviceId = "device_id",
            userId = "user_id", organizationId = "organization_id", occurredAt = "occurred_at",
            monotonicMs = "monotonic_ms", source, app, eventType = "event_type", target, context,
            durationMs = "duration_ms", sensitivity, redaction
    }

    public init(
        eventId: String, deviceId: String, userId: String, organizationId: String,
        occurredAt: String, monotonicMs: Int, app: App, eventType: String, target: Target,
        context: Context, durationMs: Int?, sensitivity: String, redaction: Redaction
    ) {
        self.eventId = eventId
        self.deviceId = deviceId
        self.userId = userId
        self.organizationId = organizationId
        self.occurredAt = occurredAt
        self.monotonicMs = monotonicMs
        self.app = app
        self.eventType = eventType
        self.target = target
        self.context = context
        self.durationMs = durationMs
        self.sensitivity = sensitivity
        self.redaction = redaction
    }
}

/// Stable SHA-256 hash (hex, 16 bytes) for identifiers and allowlisted labels.
/// Raw values NEVER leave this function's caller — only hashes are emitted.
public func stableHash(_ value: String) -> String {
    let digest = SHA256.hash(data: Data(value.utf8))
    return digest.prefix(16).map { String(format: "%02x", $0) }.joined()
}
