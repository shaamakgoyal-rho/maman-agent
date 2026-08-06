//! Observer sidecar supervision.
//!
//! The Swift semantic observer (M4) runs as a child process speaking JSON
//! Lines over stdio. This module owns the restart policy: if the observer
//! crashes, restart it at most MAX_RESTARTS times within WINDOW; after that,
//! stop and surface a failure to the UI instead of crash-looping.

use std::time::{Duration, Instant};

use serde_json::Value;

pub const MAX_RESTARTS: usize = 3;
pub const RESTART_WINDOW: Duration = Duration::from_secs(10 * 60);

/// The error code the Swift observer emits when Accessibility is not granted.
/// We surface this honestly to the UI rather than silently degrading.
pub const ACCESSIBILITY_PERMISSION_CODE: &str = "accessibility_permission_required";

/// Whether the observer may run. Spawning is gated on BOTH the consent flow
/// being complete AND observation not being paused — the sidecar never starts
/// otherwise, and is killed if either condition flips.
#[derive(Debug, Clone, Copy)]
pub struct ObserverGate {
    pub consent_complete: bool,
    pub observation_paused: bool,
}

impl ObserverGate {
    pub fn should_observe(&self) -> bool {
        self.consent_complete && !self.observation_paused
    }
}

/// Honest observer state surfaced to the pet UI (never a silent degrade).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ObserverStatus {
    /// Consent not given or observation paused — deliberately not running.
    Disabled,
    /// Spawned; waiting for the first hello/heartbeat.
    Starting,
    /// Running and reporting.
    Observing,
    /// Running but Accessibility permission is missing — the user must grant it.
    PermissionRequired,
    /// Crash-looped past the restart budget — supervision gave up.
    Failed,
}

/// Geometry of a monitored window, in logical points with a top-left origin —
/// the convention AX reports and the one Tauri's logical coordinates use, so
/// nothing converts between them.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WindowFrame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// One parsed line from the observer's stdout (the JSONL protocol).
#[derive(Debug, PartialEq)]
pub enum ObserverLine {
    Hello { observer_version: String },
    /// The inner SemanticEvent object, ready for the ingest gate (carries
    /// `source: "macos_ax"` and all required fields).
    Event(Value),
    Boundary { reason: String },
    Heartbeat { events_emitted: i64 },
    Error { code: String, fatal: bool },
    /// Geometry of the window being monitored, for docking the subtitle bar.
    /// `None` means nothing is monitored right now — the bar must detach rather
    /// than stay pinned to a stale rectangle. Transient: never persisted.
    WindowFrame { frame: Option<WindowFrame> },
    /// One masked Teach Mode frame. `jpeg_b64` is PIXELS: it must never be
    /// logged, persisted, or attached to any schema — it goes to the vision
    /// egress and is dropped. `meta` is the safe part (ids, geometry, mask count).
    TeachFrame {
        meta: Value,
        jpeg_b64: String,
    },
    /// Teach session lifecycle and per-frame refusals — reason strings only,
    /// surfaced to the panel so the user can see why nothing is being learned.
    TeachStatus {
        session_id: String,
        state: String,
        detail: Option<String>,
    },
    /// Malformed or an unrecognized message type — dropped, never crashes.
    Ignored,
}

/// Parses one observer stdout line. Unknown/garbage lines are `Ignored`, never
/// an error (a misbehaving child must not take down supervision).
pub fn parse_observer_line(line: &str) -> ObserverLine {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return ObserverLine::Ignored;
    };
    match v.get("type").and_then(|t| t.as_str()) {
        Some("hello") => ObserverLine::Hello {
            observer_version: v
                .get("observer_version")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string(),
        },
        Some("event") => match v.get("event") {
            Some(ev) if ev.is_object() => ObserverLine::Event(ev.clone()),
            _ => ObserverLine::Ignored,
        },
        Some("boundary") => ObserverLine::Boundary {
            reason: v
                .get("reason")
                .and_then(|s| s.as_str())
                .unwrap_or("hard_denied")
                .to_string(),
        },
        Some("heartbeat") => ObserverLine::Heartbeat {
            events_emitted: v.get("events_emitted").and_then(|n| n.as_i64()).unwrap_or(0),
        },
        Some("window_frame") => {
            // A frame must be complete and sane to be usable; anything else is
            // treated as "no frame" rather than half-trusted.
            let frame = v.get("frame").and_then(|f| {
                let num = |k: &str| f.get(k).and_then(|n| n.as_f64());
                match (num("x"), num("y"), num("width"), num("height")) {
                    (Some(x), Some(y), Some(width), Some(height))
                        if width > 1.0
                            && height > 1.0
                            && x.is_finite()
                            && y.is_finite()
                            && width.is_finite()
                            && height.is_finite() =>
                    {
                        Some(WindowFrame { x, y, width, height })
                    }
                    _ => None,
                }
            });
            ObserverLine::WindowFrame { frame }
        }
        Some("teach_frame") => {
            // Both halves must be present and well-formed, or the line is dropped
            // whole: a frame without its metadata cannot be gated downstream, and
            // metadata without pixels is a protocol bug worth losing.
            match (
                v.get("frame").filter(|m| m.is_object()),
                v.get("jpeg_b64").and_then(|j| j.as_str()),
            ) {
                (Some(meta), Some(jpeg)) if !jpeg.is_empty() => ObserverLine::TeachFrame {
                    meta: meta.clone(),
                    jpeg_b64: jpeg.to_string(),
                },
                _ => ObserverLine::Ignored,
            }
        }
        Some("teach_status") => match (
            v.get("session_id").and_then(|s| s.as_str()),
            v.get("state").and_then(|s| s.as_str()),
        ) {
            (Some(session_id), Some(state)) => ObserverLine::TeachStatus {
                session_id: session_id.to_string(),
                state: state.to_string(),
                detail: v.get("detail").and_then(|d| d.as_str()).map(str::to_string),
            },
            _ => ObserverLine::Ignored,
        },
        Some("error") => ObserverLine::Error {
            code: v.get("code").and_then(|s| s.as_str()).unwrap_or("").to_string(),
            fatal: v.get("fatal").and_then(|b| b.as_bool()).unwrap_or(false),
        },
        _ => ObserverLine::Ignored,
    }
}

/// Maps an observer error line to the status the UI should show.
pub fn status_for_error(code: &str, fatal: bool) -> ObserverStatus {
    if code == ACCESSIBILITY_PERMISSION_CODE {
        ObserverStatus::PermissionRequired
    } else if fatal {
        ObserverStatus::Failed
    } else {
        // Non-fatal error (e.g. teach-mode-unavailable) — keep observing.
        ObserverStatus::Observing
    }
}

#[derive(Debug, Default)]
pub struct RestartPolicy {
    crashes: Vec<Instant>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum RestartDecision {
    Restart,
    /// Too many crashes in the window: stop supervising and show a failure.
    GiveUp,
}

impl RestartPolicy {
    pub fn new() -> Self {
        Self::default()
    }

    /// Records a crash at `now` and decides whether to restart.
    pub fn on_crash(&mut self, now: Instant) -> RestartDecision {
        self.crashes.retain(|t| now.duration_since(*t) < RESTART_WINDOW);
        self.crashes.push(now);
        if self.crashes.len() > MAX_RESTARTS {
            RestartDecision::GiveUp
        } else {
            RestartDecision::Restart
        }
    }

    /// A healthy run long enough to clear history (steady state).
    pub fn on_stable(&mut self) {
        self.crashes.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restarts_up_to_three_times_within_window() {
        let mut policy = RestartPolicy::new();
        let t0 = Instant::now();
        assert_eq!(policy.on_crash(t0), RestartDecision::Restart);
        assert_eq!(policy.on_crash(t0 + Duration::from_secs(10)), RestartDecision::Restart);
        assert_eq!(policy.on_crash(t0 + Duration::from_secs(20)), RestartDecision::Restart);
        // fourth crash within 10 minutes → give up
        assert_eq!(policy.on_crash(t0 + Duration::from_secs(30)), RestartDecision::GiveUp);
    }

    #[test]
    fn old_crashes_age_out_of_the_window() {
        let mut policy = RestartPolicy::new();
        let t0 = Instant::now();
        for i in 0..3 {
            assert_eq!(
                policy.on_crash(t0 + Duration::from_secs(i * 5)),
                RestartDecision::Restart
            );
        }
        // 11 minutes later, history expired: restart allowed again
        assert_eq!(
            policy.on_crash(t0 + Duration::from_secs(11 * 60)),
            RestartDecision::Restart
        );
    }

    #[test]
    fn stable_run_clears_history() {
        let mut policy = RestartPolicy::new();
        let t0 = Instant::now();
        policy.on_crash(t0);
        policy.on_crash(t0 + Duration::from_secs(1));
        policy.on_crash(t0 + Duration::from_secs(2));
        policy.on_stable();
        assert_eq!(policy.on_crash(t0 + Duration::from_secs(3)), RestartDecision::Restart);
    }

    // ---- spawn gating (consent + pause) ----

    #[test]
    fn observer_refuses_to_start_without_consent() {
        let gate = ObserverGate { consent_complete: false, observation_paused: false };
        assert!(!gate.should_observe(), "must not observe before consent");
    }

    #[test]
    fn observer_refuses_to_start_while_paused() {
        let gate = ObserverGate { consent_complete: true, observation_paused: true };
        assert!(!gate.should_observe(), "must not observe while paused");
    }

    #[test]
    fn observer_starts_only_with_consent_and_not_paused() {
        let gate = ObserverGate { consent_complete: true, observation_paused: false };
        assert!(gate.should_observe());
    }

    // ---- JSONL protocol parsing ----

    #[test]
    fn parses_each_protocol_message_type() {
        assert_eq!(
            parse_observer_line(r#"{"type":"hello","observer_version":"0.1.0","capabilities":["macos_ax"],"pid":42}"#),
            ObserverLine::Hello { observer_version: "0.1.0".into() }
        );
        assert_eq!(
            parse_observer_line(r#"{"type":"boundary","reason":"user_private","occurred_at":"2026-07-20T10:00:00.000Z"}"#),
            ObserverLine::Boundary { reason: "user_private".into() }
        );
        assert_eq!(
            parse_observer_line(r#"{"type":"heartbeat","occurred_at":"x","events_emitted":7}"#),
            ObserverLine::Heartbeat { events_emitted: 7 }
        );
        // Window geometry: transient UI state, parsed but never stored.
        assert_eq!(
            parse_observer_line(
                r#"{"type":"window_frame","occurred_at":"x","frame":{"x":100,"y":80,"width":900,"height":600}}"#
            ),
            ObserverLine::WindowFrame {
                frame: Some(WindowFrame { x: 100.0, y: 80.0, width: 900.0, height: 600.0 })
            }
        );
        // An explicit null frame means "nothing is monitored" — the bar detaches.
        assert_eq!(
            parse_observer_line(r#"{"type":"window_frame","occurred_at":"x","frame":null}"#),
            ObserverLine::WindowFrame { frame: None }
        );
        // Half-trusting a malformed rectangle would park the bar somewhere
        // arbitrary, so an incomplete or absurd frame degrades to None.
        for bad in [
            r#"{"type":"window_frame","occurred_at":"x","frame":{"x":1,"y":2,"width":900}}"#,
            r#"{"type":"window_frame","occurred_at":"x","frame":{"x":1,"y":2,"width":0,"height":600}}"#,
            r#"{"type":"window_frame","occurred_at":"x","frame":{"x":"left","y":2,"width":9,"height":6}}"#,
        ] {
            assert_eq!(
                parse_observer_line(bad),
                ObserverLine::WindowFrame { frame: None },
                "should not trust: {bad}"
            );
        }
        assert_eq!(
            parse_observer_line(r#"{"type":"error","code":"accessibility_permission_required","message":"m","fatal":false}"#),
            ObserverLine::Error {
                code: ACCESSIBILITY_PERMISSION_CODE.into(),
                fatal: false
            }
        );
    }

    #[test]
    fn teach_frame_lines_carry_meta_and_pixels_or_are_dropped_whole() {
        let line = r#"{"type":"teach_frame","frame":{"frame_id":"f1","session_id":"s1","captured_at":"2026-08-05T12:00:00.000Z","bundle_id":"com.google.Chrome","width":1400,"height":900,"masked_regions":2},"jpeg_b64":"/9j/4AAQ"}"#;
        match parse_observer_line(line) {
            ObserverLine::TeachFrame { meta, jpeg_b64 } => {
                assert_eq!(meta.get("frame_id").and_then(|v| v.as_str()), Some("f1"));
                assert_eq!(meta.get("masked_regions").and_then(|v| v.as_i64()), Some(2));
                assert_eq!(jpeg_b64, "/9j/4AAQ");
            }
            other => panic!("expected TeachFrame, got {other:?}"),
        }
        // Metadata without pixels, or pixels without metadata: dropped whole.
        for bad in [
            r#"{"type":"teach_frame","frame":{"frame_id":"f1"}}"#,
            r#"{"type":"teach_frame","frame":{"frame_id":"f1"},"jpeg_b64":""}"#,
            r#"{"type":"teach_frame","jpeg_b64":"/9j/"}"#,
        ] {
            assert_eq!(parse_observer_line(bad), ObserverLine::Ignored, "{bad}");
        }
    }

    #[test]
    fn teach_status_lines_carry_reasons_never_content() {
        assert_eq!(
            parse_observer_line(
                r#"{"type":"teach_status","session_id":"s1","state":"frame_refused","detail":"secure_field_focused","occurred_at":"x"}"#
            ),
            ObserverLine::TeachStatus {
                session_id: "s1".into(),
                state: "frame_refused".into(),
                detail: Some("secure_field_focused".into()),
            }
        );
        assert_eq!(
            parse_observer_line(r#"{"type":"teach_status","session_id":"s1","state":"started","occurred_at":"x"}"#),
            ObserverLine::TeachStatus {
                session_id: "s1".into(),
                state: "started".into(),
                detail: None,
            }
        );
        assert_eq!(
            parse_observer_line(r#"{"type":"teach_status","state":"started"}"#),
            ObserverLine::Ignored
        );
    }

    #[test]
    fn garbage_and_unknown_lines_are_ignored_never_panic() {
        assert_eq!(parse_observer_line("not json"), ObserverLine::Ignored);
        assert_eq!(parse_observer_line("{}"), ObserverLine::Ignored);
        assert_eq!(parse_observer_line(r#"{"type":"nope"}"#), ObserverLine::Ignored);
        assert_eq!(parse_observer_line(r#"{"type":"event"}"#), ObserverLine::Ignored);
    }

    #[test]
    fn event_line_yields_an_ingestable_object_with_source() {
        let line = r#"{"type":"event","event":{"schema_version":1,"event_id":"0191aaaa-0000-7000-8000-000000000001","source":"macos_ax","occurred_at":"2026-07-20T10:00:00.000Z","event_type":"element_focused","sensitivity":"internal","app":{"display_name":"Salesforce"}}}"#;
        match parse_observer_line(line) {
            ObserverLine::Event(ev) => {
                // The inner object is exactly what the ingest gate/insert_event needs.
                assert_eq!(ev.get("source").and_then(|s| s.as_str()), Some("macos_ax"));
                assert_eq!(
                    ev.get("event_id").and_then(|s| s.as_str()),
                    Some("0191aaaa-0000-7000-8000-000000000001")
                );
                assert!(ev.pointer("/app/display_name").is_some());
            }
            other => panic!("expected Event, got {other:?}"),
        }
    }

    // ---- honest status (never a silent degrade) ----

    #[test]
    fn missing_accessibility_permission_surfaces_permission_required() {
        assert_eq!(
            status_for_error(ACCESSIBILITY_PERMISSION_CODE, false),
            ObserverStatus::PermissionRequired
        );
    }

    #[test]
    fn a_fatal_error_surfaces_failed_a_nonfatal_one_keeps_observing() {
        assert_eq!(status_for_error("some_crash", true), ObserverStatus::Failed);
        assert_eq!(status_for_error("teach_mode_unavailable", false), ObserverStatus::Observing);
    }
}
