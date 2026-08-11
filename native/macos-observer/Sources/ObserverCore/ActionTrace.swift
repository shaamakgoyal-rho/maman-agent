import CryptoKit
import Foundation

/// THE REPLAYABLE LAYER FOR NATIVE APPS.
///
/// `SemanticEvent` is the lossy projection: role, hashed label, event kind. It
/// cannot address a control again, which is why a workflow observed in a desktop
/// app used to end with Maman asking the user to describe it.
///
/// This produces `ObservedAction`s matching the TypeScript contract in
/// packages/contracts/src/action-trace.ts, so a trace built here and a trace
/// built by the Chrome extension are the same shape and pass the same guards.
///
/// It reuses `decideObservation` rather than reimplementing a deny list: capture
/// and tracing must never disagree about what is off limits. A refused
/// notification becomes a HOLE in the trace, never a step.
public enum ActionTrace {
    /// A full SHA-256 hex digest (64 chars).
    ///
    /// Deliberately NOT `stableHash`, which truncates to 16 bytes: the contract's
    /// `labelHash` requires 64 hex characters, so a truncated digest would be
    /// rejected by the desktop after a perfectly good capture. Window titles are
    /// hashed at full width because they routinely carry customer names.
    public static func titleHash(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    /// One AX interaction, as the observer saw it.
    public struct Observation: Sendable {
        public let at: String
        /// "commit", "press", "select", "read", "navigate".
        public let operation: String
        public let bundleId: String?
        public let role: String?
        public let subrole: String?
        /// The control's label — a label, never the data inside it.
        public let label: String?
        public let identifier: String?
        public let ancestry: [String]
        /// Menu path for a menu action: ["File", "Export To", "CSV…"].
        public let menuPath: [String]
        public let windowTitle: String?
        /// True when this step read a value another step will consume.
        public let producesValue: Bool
        /// Step order pre-assigned at capture time, so the pattern event
        /// emitted for the SAME interaction can be stamped with it before the
        /// trace flushes. Monotonic per session — survives the drop-oldest cap
        /// without shifting, which positional numbering would not.
        public let stepOrder: Int?

        public init(
            at: String,
            operation: String,
            bundleId: String? = nil,
            role: String? = nil,
            subrole: String? = nil,
            label: String? = nil,
            identifier: String? = nil,
            ancestry: [String] = [],
            menuPath: [String] = [],
            windowTitle: String? = nil,
            producesValue: Bool = false,
            stepOrder: Int? = nil
        ) {
            self.at = at
            self.operation = operation
            self.bundleId = bundleId
            self.role = role
            self.subrole = subrole
            self.label = label
            self.identifier = identifier
            self.ancestry = ancestry
            self.menuPath = menuPath
            self.windowTitle = windowTitle
            self.producesValue = producesValue
            self.stepOrder = stepOrder
        }
    }

    /// Matches `StableTarget` in the contract.
    public struct Target: Encodable, Sendable, Equatable {
        public let role: String
        public let accessible_name: String?
        public let identifier: String?
        public let ancestry: [String]
        public let menu_path: [String]
        public let window_title_hash: String?
    }

    /// Matches `ValueBinding`. A raw value has no representation here, by design.
    public enum Binding: Encodable, Sendable, Equatable {
        case none
        case fromStep(step: Int, output: String)
        case runtimeInput(inputId: String, prompt: String)

        enum CodingKeys: String, CodingKey {
            case kind, step, output, input_id, prompt
        }

        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            switch self {
            case .none:
                try c.encode("none", forKey: .kind)
            case let .fromStep(step, output):
                try c.encode("from_step", forKey: .kind)
                try c.encode(step, forKey: .step)
                try c.encode(output, forKey: .output)
            case let .runtimeInput(inputId, prompt):
                try c.encode("runtime_input", forKey: .kind)
                try c.encode(inputId, forKey: .input_id)
                try c.encode(prompt, forKey: .prompt)
            }
        }
    }

    public struct Preconditions: Encodable, Sendable, Equatable {
        public let app_bundle_id: String?
        public let focused_window_title_hash: String?
        public let requires_foreground: Bool
        public let requires_user_presence: Bool
    }

    public struct Effect: Encodable, Sendable, Equatable {
        public let kind: String
        public let readback: String
    }

    /// Matches `ObservedAction`.
    public struct Step: Encodable, Sendable {
        public let order: Int
        public let surface: String
        public let app_bundle_id: String?
        public let operation: String
        public let target: Target
        public var value_binding: Binding
        public let preconditions: Preconditions
        public let expected_effect: Effect?
    }

    /// Matches `ProtectedSegment`: a hole and its reason, never its contents.
    public struct ProtectedSegment: Encodable, Sendable, Equatable {
        public let started_at: String
        public let ended_at: String
        public let reason: String
    }

    public struct AppSurface: Encodable, Sendable {
        public let category: String
        public let bundle_id: String?
    }

    /// Matches `LocalActionTrace`. `local_only` is always true — a trace has no
    /// shape the sync path would accept.
    public struct Trace: Encodable, Sendable {
        public let schema_version: Int
        public let trace_id: String
        public let started_at: String
        public let ended_at: String
        public let apps: [AppSurface]
        public let steps: [Step]
        public let protected_segments: [ProtectedSegment]
        public let pattern_event_refs: [String]
        public let local_only: Bool
    }

    /// Why an observation was refused, in the contract's vocabulary.
    private static func reasonName(_ reason: ObserverMessage.BoundaryReason) -> String {
        switch reason {
        case .hardDenied: return "hard_denied_app"
        case .userPrivate: return "user_denied"
        case .secureField: return "secure_field"
        // A private window is its own reason in the contract; folding it into
        // "user_denied" would lose the distinction between "you excluded this"
        // and "this was incognito".
        case .privateWindow: return "private_browsing"
        }
    }

    /// A whole session of AX interactions → one trace, with dataflow recovered.
    ///
    /// The dataflow rules mirror the browser assembler exactly: a write takes its
    /// value from the most recent READ (the copy/paste edge), a write with no
    /// source becomes a runtime input slot the pet asks about, a copied value is
    /// consumed once, and a value never carries across a protected hole — binding
    /// through a gap would assert dataflow the observer did not see.
    ///
    /// Returns nil when nothing survived capture: a session of refusals produces
    /// no trace rather than an empty one that would read as "nothing happened".
    public static func assemble(
        observations: [Observation],
        traceId: String,
        appCategory: String,
        allowlistBundles: [String],
        privateApps: [String],
        paused: Bool
    ) -> Trace? {
        var steps: [Step] = []
        var holes: [ProtectedSegment] = []
        var lastRead: (order: Int, output: String)?
        // Highest order used so far. A pre-assigned order (stamped at capture)
        // wins; an unstamped observation continues above the maximum rather
        // than positionally, so the two numbering sources can never collide —
        // the contract rejects duplicate orders, and a collision here would
        // refuse a whole trace after a perfectly good capture.
        var maxOrder = 0

        for observation in observations {
            let decision = decideObservation(
                bundleId: observation.bundleId,
                appName: nil,
                role: observation.role,
                subrole: observation.subrole,
                label: observation.label,
                allowlistBundles: allowlistBundles,
                privateApps: privateApps,
                paused: paused
            )
            switch decision {
            case .drop:
                lastRead = nil
                continue
            case let .boundary(reason):
                holes.append(
                    ProtectedSegment(
                        started_at: observation.at,
                        ended_at: observation.at,
                        reason: reasonName(reason)
                    ))
                lastRead = nil
                continue
            case .emit:
                break
            }

            let order = observation.stepOrder ?? maxOrder + 1
            maxOrder = max(maxOrder, order)
            let writes = observation.operation == "commit" || observation.operation == "set_value"
            var binding: Binding = .none
            if observation.producesValue {
                lastRead = (order, observation.label ?? observation.identifier ?? "value")
            } else if writes {
                if let source = lastRead {
                    binding = .fromStep(step: source.order, output: source.output)
                } else {
                    let base = observation.label ?? observation.identifier ?? "input_\(order)"
                    binding = .runtimeInput(
                        inputId: slug(base),
                        prompt: observation.label.map { "What should I put in \($0)?" }
                            ?? "What value should I use here?"
                    )
                }
                lastRead = nil
            }

            steps.append(
                Step(
                    order: order,
                    surface: "macos_ax",
                    app_bundle_id: observation.bundleId,
                    operation: writes ? "set_value" : observation.operation,
                    target: Target(
                        role: observation.role ?? "generic",
                        accessible_name: observation.label,
                        identifier: observation.identifier,
                        ancestry: Array(observation.ancestry.prefix(12)),
                        menu_path: Array(observation.menuPath.prefix(8)),
                        window_title_hash: observation.windowTitle.map(titleHash)
                    ),
                    value_binding: binding,
                    preconditions: Preconditions(
                        app_bundle_id: observation.bundleId,
                        focused_window_title_hash: observation.windowTitle.map(titleHash),
                        // A UI action into a background window is a lie about
                        // what happened, and a write needs somebody watching.
                        requires_foreground: true,
                        requires_user_presence: writes
                    ),
                    expected_effect: writes
                        ? Effect(kind: "value_committed", readback: "reread_target") : nil
                ))
        }

        guard let first = observations.first, let last = observations.last, !steps.isEmpty else {
            return nil
        }
        return Trace(
            schema_version: 1,
            trace_id: traceId,
            started_at: first.at,
            ended_at: last.at,
            apps: [AppSurface(category: appCategory, bundle_id: observations.first?.bundleId)],
            steps: steps,
            protected_segments: holes,
            pattern_event_refs: [],
            local_only: true
        )
    }

    /// "Company Domain" → "company_domain". Ids are for binding, not display.
    static func slug(_ value: String) -> String {
        let lowered = value.lowercased()
        let mapped = lowered.map { ch -> Character in
            (ch.isLetter && ch.isASCII) || ch.isNumber ? ch : "_"
        }
        let collapsed = String(mapped).split(separator: "_", omittingEmptySubsequences: true)
            .joined(separator: "_")
        return String(collapsed.prefix(48))
    }
}
