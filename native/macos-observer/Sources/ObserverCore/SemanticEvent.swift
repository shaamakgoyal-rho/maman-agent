import Foundation
import CryptoKit

/// The WorkflowEvent shape the observer emits (subset builder — the Rust core
/// re-validates against the full schema before persistence).
public struct SemanticEvent: Encodable, Sendable {
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
    /// The trace stamp: id of the local action trace being recorded as this
    /// event happened, and which step of it this interaction became. An opaque
    /// local UUID + counter — never content. Nil when no trace step was
    /// recorded (a refused observation, or app-activation bookkeeping).
    public var traceRef: String?
    public var traceStepOrder: Int?

    public struct App: Encodable, Sendable {
        public var bundleId: String?
        public var displayName: String
        /// The page HOST when the app is a browser whose focused page
        /// identified itself via AXURL — the field origin-scoped triggers
        /// match on. Host only, never a path or query, and absent entirely
        /// for private windows and non-browser apps.
        public var domain: String?
        enum CodingKeys: String, CodingKey {
            case bundleId = "bundle_id", displayName = "display_name", domain
        }
        public init(bundleId: String?, displayName: String, domain: String? = nil) {
            self.bundleId = bundleId
            self.displayName = displayName
            self.domain = domain
        }
    }
    public struct Target: Encodable, Sendable {
        public var role: String?
        public var semanticType: String?
        public var stableIdHash: String?
        public var labelHash: String?
        /// Pack label-pattern strings that matched the (pre-hash) label — pack
        /// constants only, never label text. See LabelPatterns.swift.
        public var labelPatternHits: [String]?
        /// Calendar dates read from the (pre-hash) label for Layer 5 date-driven
        /// triggers. Normalized date + confidence ONLY — never a substring of the
        /// label, never the record it belongs to. See DateExtraction.swift.
        public var labelDates: [LabelDate]?

        /// One date read from a label. Deliberately has no field for the text it
        /// came from: there is no shape here that could carry content.
        public struct LabelDate: Encodable, Equatable, Sendable {
            public let date: String
            public let confidence: Double
            public init(date: String, confidence: Double) {
                self.date = date
                self.confidence = confidence
            }
        }

        enum CodingKeys: String, CodingKey {
            case role, semanticType = "semantic_type", stableIdHash = "stable_id_hash",
                labelHash = "label_hash", labelPatternHits = "label_pattern_hits",
                labelDates = "label_dates"
        }
        public init(
            role: String?, semanticType: String?, stableIdHash: String?, labelHash: String?,
            labelPatternHits: [String]? = nil, labelDates: [LabelDate]? = nil
        ) {
            self.role = role
            self.semanticType = semanticType
            self.stableIdHash = stableIdHash
            self.labelHash = labelHash
            self.labelPatternHits = labelPatternHits
            self.labelDates = labelDates
        }
    }
    public struct Context: Encodable, Sendable {
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
    public struct Redaction: Encodable, Sendable {
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
            durationMs = "duration_ms", sensitivity, redaction, traceRef = "trace_ref",
            traceStepOrder = "trace_step_order"
    }

    public init(
        eventId: String, deviceId: String, userId: String, organizationId: String,
        occurredAt: String, monotonicMs: Int, app: App, eventType: String, target: Target,
        context: Context, durationMs: Int?, sensitivity: String, redaction: Redaction,
        traceRef: String? = nil, traceStepOrder: Int? = nil
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
        self.traceRef = traceRef
        self.traceStepOrder = traceStepOrder
    }
}

/// Stable SHA-256 hash (hex, 16 bytes) for identifiers and allowlisted labels.
/// Raw values NEVER leave this function's caller — only hashes are emitted.
public func stableHash(_ value: String) -> String {
    let digest = SHA256.hash(data: Data(value.utf8))
    return digest.prefix(16).map { String(format: "%02x", $0) }.joined()
}
