//! The Rust-side trigger daemon — the half that does not need a webview.
//!
//! The panel's agent service evaluates triggers for as long as its webview is
//! alive, which is app-lifetime in normal use — but "proactive" must not mean
//! "proactive while the panel window exists". Live observer/relay events are
//! ingested HERE, in Rust, and this module evaluates them against the persisted
//! agents directly, so a firing happens even with every screen closed: the
//! status bar (its own window) shows the beat, and the firing is appended to a
//! file the panel drains on next open.
//!
//! Deliberately narrow. This daemon MATCHES and ANNOUNCES; it never executes.
//! Execution needs discovery, inputs, approvals — the panel's runtime owns
//! those, and a daemon that wrote to pages while no one could watch would
//! violate the presence gate the actuator enforces anyway. Dispatch still
//! happens for what this daemon staged: on next boot the panel drains the
//! file through its normal autonomy routing, so an agent granted
//! draft_autonomy gets its shadow run (a proposal, never a write) without
//! anyone re-approving the firing.
//!
//! Privacy: matching consumes exactly the canonical-token fields (category,
//! event type, role, semantic, object, host) that pattern learning consumes.
//! The staged-runs file carries agent ids, names, and the same redacted context
//! — never content.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// One agent's trigger, as the daemon holds it. Parsed from agents.json.
#[derive(Clone, Debug, PartialEq)]
pub struct TriggerRecord {
    pub agent_id: String,
    pub agent_name: String,
    pub app_category: String,
    pub object_type: Option<String>,
    /// Host of the trigger's origin ("acme.example"), compared EXACTLY against
    /// the observed domain — the same rule as the actuation allowlist.
    pub origin_host: Option<String>,
    pub cooldown_seconds: u64,
}

/// One agent's SCHEDULE trigger (`{type:"schedule", cron, timezone}`). These
/// used to be silently discarded — a cron agent was dead the moment it was
/// created, with nothing anywhere that could ever tick it.
#[derive(Clone, Debug, PartialEq)]
pub struct ScheduleRecord {
    pub agent_id: String,
    pub agent_name: String,
    pub cron: String,
    pub timezone: String,
}

/// The redacted context fields evaluation needs.
pub struct ContextFields<'a> {
    pub app_category: &'a str,
    pub object_type: &'a str,
    pub domain: Option<&'a str>,
}

#[derive(Default)]
struct Inner {
    records: Vec<TriggerRecord>,
    schedules: Vec<ScheduleRecord>,
    last_fired: HashMap<String, Instant>,
    /// End of the last schedule sweep — the next sweep looks for cron
    /// occurrences in (last_schedule_sweep, now].
    last_schedule_sweep: Option<chrono::DateTime<chrono::Utc>>,
}

/// Tauri-managed daemon state.
#[derive(Default)]
pub struct TriggerServiceState(Mutex<Inner>);

/// Agent states the daemon considers live. `draft` never fires: creation did
/// not finish, and a trigger for it would announce an agent that cannot run.
const LIVE_STATES: [&str; 3] = ["shadow", "supervised", "active"];

/// Parses agents.json into trigger records. Pure, so it is unit-testable
/// without a filesystem, and TOLERANT per record: one agent whose shape this
/// build cannot read must not silence every other agent's trigger.
pub fn parse_agents(json: &str) -> Vec<TriggerRecord> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(json) else {
        return Vec::new();
    };
    let Some(agents) = value.get("agents").and_then(|a| a.as_array()) else {
        return Vec::new();
    };

    let mut records = Vec::new();
    for agent in agents {
        let state = agent.get("state").and_then(|s| s.as_str()).unwrap_or("");
        if !LIVE_STATES.contains(&state) {
            continue;
        }
        let (Some(agent_id), Some(name)) = (
            agent.get("agent_id").and_then(|v| v.as_str()),
            agent.get("name").and_then(|v| v.as_str()),
        ) else {
            continue;
        };
        // The LATEST version's spec carries the installed trigger.
        let Some(trigger) = agent
            .get("versions")
            .and_then(|v| v.as_array())
            .and_then(|v| v.last())
            .and_then(|v| v.get("spec"))
            .and_then(|s| s.get("trigger"))
        else {
            continue;
        };
        // Every trigger type is handled EXPLICITLY. The old code continued on
        // anything non-context, which silently discarded every schedule agent.
        match trigger.get("type").and_then(|t| t.as_str()) {
            Some("context") => {}
            // Schedule triggers are parsed by `parse_schedules` below.
            Some("schedule") => continue,
            // Manual is by design (the user runs it); event triggers are the
            // server's business, not this daemon's.
            other => {
                #[cfg(debug_assertions)]
                eprintln!("trigger_service: skipping trigger type {other:?} for {agent_id}");
                continue;
            }
        }
        let Some(app_category) = trigger.get("app_category").and_then(|c| c.as_str()) else {
            continue;
        };
        records.push(TriggerRecord {
            agent_id: agent_id.to_string(),
            agent_name: name.to_string(),
            app_category: app_category.to_string(),
            object_type: trigger
                .get("object_type")
                .and_then(|o| o.as_str())
                .map(|o| o.to_string()),
            origin_host: trigger
                .get("origin")
                .and_then(|o| o.as_str())
                .map(|o| o.trim_start_matches("https://").split('/').next().unwrap_or("").to_string())
                .filter(|h| !h.is_empty()),
            cooldown_seconds: trigger
                .get("cooldown_seconds")
                .and_then(|c| c.as_u64())
                .unwrap_or(300),
        });
    }
    records
}

/// Parses agents.json into SCHEDULE records — the same liveness and
/// latest-version rules as `parse_agents`, for `{type:"schedule"}` triggers.
pub fn parse_schedules(json: &str) -> Vec<ScheduleRecord> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(json) else {
        return Vec::new();
    };
    let Some(agents) = value.get("agents").and_then(|a| a.as_array()) else {
        return Vec::new();
    };
    let mut schedules = Vec::new();
    for agent in agents {
        let state = agent.get("state").and_then(|s| s.as_str()).unwrap_or("");
        if !LIVE_STATES.contains(&state) {
            continue;
        }
        let (Some(agent_id), Some(name)) = (
            agent.get("agent_id").and_then(|v| v.as_str()),
            agent.get("name").and_then(|v| v.as_str()),
        ) else {
            continue;
        };
        let Some(trigger) = agent
            .get("versions")
            .and_then(|v| v.as_array())
            .and_then(|v| v.last())
            .and_then(|v| v.get("spec"))
            .and_then(|s| s.get("trigger"))
        else {
            continue;
        };
        if trigger.get("type").and_then(|t| t.as_str()) != Some("schedule") {
            continue;
        }
        let (Some(cron), Some(timezone)) = (
            trigger.get("cron").and_then(|c| c.as_str()),
            trigger.get("timezone").and_then(|t| t.as_str()),
        ) else {
            continue;
        };
        schedules.push(ScheduleRecord {
            agent_id: agent_id.to_string(),
            agent_name: name.to_string(),
            cron: cron.to_string(),
            timezone: timezone.to_string(),
        });
    }
    schedules
}

/// Whether the cron expression has an occurrence in `(window_start, now]`,
/// evaluated in the trigger's own timezone (the contract requires one). Pure —
/// this is the whole scheduling decision, so it is unit-testable without time.
/// An unparseable cron or unknown timezone is FALSE, never a fire: a broken
/// schedule must not become an agent that runs at every tick.
pub fn schedule_due(
    cron: &str,
    timezone: &str,
    window_start: chrono::DateTime<chrono::Utc>,
    now: chrono::DateTime<chrono::Utc>,
) -> bool {
    let Ok(tz) = timezone.parse::<chrono_tz::Tz>() else {
        return false;
    };
    let Ok(parsed) = cron.parse::<croner::Cron>() else {
        return false;
    };
    match parsed.find_next_occurrence(&window_start.with_timezone(&tz), false) {
        Ok(next) => next.with_timezone(&chrono::Utc) <= now,
        Err(_) => false,
    }
}

/// Does this context wake this trigger? Pure; exact comparisons only.
///
/// The origin host is the PRECISE selector: when a trigger names one (every
/// trace-compiled browser agent does), the host alone gates the site and
/// app_category is not required. The compiler stamps "browser" while ingest
/// categorizes the same domain as "crm"/"email", so requiring both equalities
/// rejected every SaaS agent. Without an origin, app_category is the selector.
pub fn matches(record: &TriggerRecord, ctx: &ContextFields<'_>) -> bool {
    match (&record.origin_host, ctx.domain) {
        // A bare host compared EXACTLY — no suffix match, so
        // evil-example.com cannot wake an agent meant for example.com.
        (Some(host), Some(domain)) => {
            if domain != host {
                return false;
            }
        }
        // A context with NO domain (the observation lane could not read the
        // page identity) falls back to the category comparison — the same
        // rule as the panel runtime, so daemon and panel cannot disagree.
        // The shadow's own discovery still verifies the real page against
        // the origin allowlist before anything is proposed.
        (Some(_), None) | (None, _) => {
            if record.app_category != ctx.app_category {
                return false;
            }
        }
    }
    if let Some(object_type) = &record.object_type {
        if object_type != ctx.object_type {
            return false;
        }
    }
    true
}

/// One firing, as persisted for the panel and emitted to the status bar.
#[derive(Serialize)]
struct Firing<'a> {
    agent_id: &'a str,
    agent_name: &'a str,
    at: &'a str,
    context: &'a serde_json::Value,
}

/// Reloads trigger records from agents.json. Called at setup and after every
/// agents_save, so a newly created agent's trigger is live the moment the file
/// is. Cooldown history survives the reload on purpose: re-saving the file must
/// not reset every agent's cooldown and unleash a burst.
pub fn reload<R: Runtime>(app: &AppHandle<R>, agents_json: Option<&str>) {
    let records = agents_json.map(parse_agents).unwrap_or_default();
    let schedules = agents_json.map(parse_schedules).unwrap_or_default();
    let state = app.state::<TriggerServiceState>();
    let mut inner = state.0.lock().expect("trigger state poisoned");
    inner.records = records;
    inner.schedules = schedules;
    // Drop cooldown history for agents that no longer exist; the survivors keep
    // theirs, so re-saving the file cannot reset every cooldown at once.
    let keep: Vec<String> = inner
        .records
        .iter()
        .map(|r| r.agent_id.clone())
        .chain(inner.schedules.iter().map(|s| s.agent_id.clone()))
        .collect();
    inner.last_fired.retain(|id, _| keep.iter().any(|k| k == id));
}

/// Evaluates one stored live event's redacted context. On a match past its
/// cooldown: emits `agent_trigger_fired` on the app-event channel (the status
/// bar and, when open, the panel both listen) and appends the firing to
/// staged_runs.json so a closed panel finds it on next open.
pub fn evaluate<R: Runtime>(app: &AppHandle<R>, context: &serde_json::Value) {
    let ctx = ContextFields {
        app_category: context.get("app_category").and_then(|v| v.as_str()).unwrap_or(""),
        object_type: context.get("object_type").and_then(|v| v.as_str()).unwrap_or("-"),
        domain: context.get("domain").and_then(|v| v.as_str()),
    };
    let occurred_at = context
        .get("occurred_at")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let fired: Vec<(String, String)> = {
        let state = app.state::<TriggerServiceState>();
        let mut inner = state.0.lock().expect("trigger state poisoned");
        let now = Instant::now();
        let mut fired = Vec::new();
        // Collect matches first, then update cooldowns, to keep the borrow simple.
        let matching: Vec<TriggerRecord> = inner
            .records
            .iter()
            .filter(|r| matches(r, &ctx))
            .cloned()
            .collect();
        for record in matching {
            let cool = std::time::Duration::from_secs(record.cooldown_seconds);
            if let Some(last) = inner.last_fired.get(&record.agent_id) {
                if now.duration_since(*last) < cool {
                    continue;
                }
            }
            inner.last_fired.insert(record.agent_id.clone(), now);
            fired.push((record.agent_id, record.agent_name));
        }
        fired
    };

    for (agent_id, agent_name) in fired {
        announce_firing(app, &agent_id, &agent_name, &occurred_at, context);
    }
}

/// Emits one firing on the app-event channel, beats the status bar, and
/// appends it to the staged-runs spool — the shared tail of both the context
/// path and the schedule path.
fn announce_firing<R: Runtime>(
    app: &AppHandle<R>,
    agent_id: &str,
    agent_name: &str,
    at: &str,
    context: &serde_json::Value,
) {
    let firing = Firing { agent_id, agent_name, at, context };
    let _ = app.emit(
        "maman-app-events",
        serde_json::json!({ "type": "agent_trigger_fired", "firing": &firing }),
    );
    // The status bar is a separate window and survives the panel closing —
    // this beat is what makes a daemon firing VISIBLE with no panel open.
    // "suggested", not "running": the daemon only MATCHES and ANNOUNCES —
    // nothing is executing, and the beat must not claim otherwise.
    let _ = app.emit(
        "maman-app-events",
        serde_json::json!({
            "type": "status_beat",
            "beat": { "kind": "suggested", "title": agent_name }
        }),
    );
    append_staged(app, &firing);
}

/// One schedule sweep: fires every schedule trigger with a cron occurrence in
/// (last sweep, now], honoring the SAME per-agent cooldown map as the context
/// path (default 300s — a sweep overlap must not double-fire). Called from a
/// ~30s tokio interval in `.setup()`; the first sweep only opens the window,
/// so a restart never back-fires occurrences from before the app was running.
pub fn evaluate_schedules<R: Runtime>(app: &AppHandle<R>) {
    let now_utc = chrono::Utc::now();
    let at = now_utc.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    // Synthetic context: a schedule firing observed nothing — no domain, no
    // role, no object. The shape mirrors the context path so every consumer
    // (status bar, panel drain) reads one vocabulary.
    let context = serde_json::json!({
        "source": "schedule",
        "app_category": "-",
        "event_type": "schedule_due",
        "target_role": "-",
        "semantic_type": "-",
        "object_type": "-",
        "occurred_at": at,
    });

    let fired: Vec<(String, String)> = {
        let state = app.state::<TriggerServiceState>();
        let mut inner = state.0.lock().expect("trigger state poisoned");
        let Some(window_start) = inner.last_schedule_sweep.replace(now_utc) else {
            return; // first sweep: open the window, fire nothing retroactively
        };
        let now = Instant::now();
        let due: Vec<ScheduleRecord> = inner
            .schedules
            .iter()
            .filter(|s| schedule_due(&s.cron, &s.timezone, window_start, now_utc))
            .cloned()
            .collect();
        let mut fired = Vec::new();
        for record in due {
            let cool = std::time::Duration::from_secs(300);
            if let Some(last) = inner.last_fired.get(&record.agent_id) {
                if now.duration_since(*last) < cool {
                    continue;
                }
            }
            inner.last_fired.insert(record.agent_id.clone(), now);
            fired.push((record.agent_id, record.agent_name));
        }
        fired
    };

    for (agent_id, agent_name) in fired {
        announce_firing(app, &agent_id, &agent_name, &at, &context);
    }
}

/// Appends one firing to staged_runs.json, capped so the file cannot grow
/// without bound while the panel stays closed.
fn append_staged<R: Runtime>(app: &AppHandle<R>, firing: &Firing<'_>) {
    let Ok(path) = crate::config_path(app, "staged_runs.json") else {
        return;
    };
    let mut list: Vec<serde_json::Value> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    if let Ok(value) = serde_json::to_value(firing) {
        list.insert(0, value);
    }
    list.truncate(50);
    if let Ok(json) = serde_json::to_string(&list) {
        let _ = std::fs::write(&path, json);
    }
}

/// Returns and clears the persisted firings — the panel calls this on boot so
/// triggers that fired while it was closed are not lost, and not replayed.
#[tauri::command]
pub fn staged_runs_drain<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    let path = crate::config_path(&app, "staged_runs.json")?;
    match std::fs::read_to_string(&path) {
        Ok(contents) => {
            let _ = std::fs::remove_file(&path);
            Ok(contents)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok("[]".into()),
        Err(e) => Err(format!("read failed: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agents_json(state: &str, trigger: serde_json::Value) -> String {
        serde_json::json!({
            "schema_version": 1,
            "agents": [{
                "agent_id": "a-1",
                "name": "phone helper",
                "state": state,
                "versions": [{ "spec": { "trigger": trigger } }]
            }]
        })
        .to_string()
    }

    fn context_trigger() -> serde_json::Value {
        serde_json::json!({
            "type": "context",
            "app_category": "browser",
            "object_type": "contact",
            "origin": "https://acme.example",
            "cooldown_seconds": 300
        })
    }

    #[test]
    fn parses_a_live_agent_with_a_context_trigger() {
        let records = parse_agents(&agents_json("shadow", context_trigger()));
        assert_eq!(records.len(), 1);
        let r = &records[0];
        assert_eq!(r.agent_id, "a-1");
        assert_eq!(r.app_category, "browser");
        assert_eq!(r.object_type.as_deref(), Some("contact"));
        // The origin is stored as its HOST, because observation reports hosts.
        assert_eq!(r.origin_host.as_deref(), Some("acme.example"));
    }

    #[test]
    fn a_draft_agent_never_fires() {
        // Creation did not finish; announcing its trigger would announce an
        // agent that cannot run.
        assert!(parse_agents(&agents_json("draft", context_trigger())).is_empty());
        assert!(parse_agents(&agents_json("paused", context_trigger())).is_empty());
        assert!(parse_agents(&agents_json("archived", context_trigger())).is_empty());
    }

    #[test]
    fn manual_triggers_are_not_the_daemon_s_business() {
        assert!(
            parse_agents(&agents_json("shadow", serde_json::json!({ "type": "manual" })))
                .is_empty()
        );
    }

    fn schedule_trigger() -> serde_json::Value {
        serde_json::json!({
            "type": "schedule",
            "cron": "0 9 * * 1",
            "timezone": "America/New_York"
        })
    }

    #[test]
    fn a_schedule_trigger_becomes_a_schedule_record_not_a_context_one() {
        let json = agents_json("active", schedule_trigger());
        assert!(parse_agents(&json).is_empty());
        let schedules = parse_schedules(&json);
        assert_eq!(schedules.len(), 1);
        assert_eq!(schedules[0].cron, "0 9 * * 1");
        assert_eq!(schedules[0].timezone, "America/New_York");
    }

    #[test]
    fn a_draft_schedule_agent_never_fires_either() {
        assert!(parse_schedules(&agents_json("draft", schedule_trigger())).is_empty());
    }

    #[test]
    fn schedule_due_finds_an_occurrence_inside_the_window_only() {
        use chrono::TimeZone;
        // Monday 2026-08-17 09:00 America/New_York == 13:00 UTC (EDT).
        let before = chrono::Utc.with_ymd_and_hms(2026, 8, 17, 12, 59, 0).unwrap();
        let after = chrono::Utc.with_ymd_and_hms(2026, 8, 17, 13, 0, 30).unwrap();
        assert!(schedule_due("0 9 * * 1", "America/New_York", before, after));
        // A window that ends before the occurrence: not due.
        let too_early = chrono::Utc.with_ymd_and_hms(2026, 8, 17, 12, 59, 30).unwrap();
        assert!(!schedule_due("0 9 * * 1", "America/New_York", before, too_early));
        // The window is EXCLUSIVE of its start: an occurrence exactly at the
        // last sweep was already that sweep's business.
        let at_occurrence = chrono::Utc.with_ymd_and_hms(2026, 8, 17, 13, 0, 0).unwrap();
        assert!(!schedule_due("0 9 * * 1", "America/New_York", at_occurrence, after));
    }

    #[test]
    fn broken_cron_or_timezone_is_never_due_rather_than_always_due() {
        use chrono::TimeZone;
        let a = chrono::Utc.with_ymd_and_hms(2026, 8, 17, 0, 0, 0).unwrap();
        let b = chrono::Utc.with_ymd_and_hms(2026, 8, 18, 0, 0, 0).unwrap();
        assert!(!schedule_due("not a cron", "America/New_York", a, b));
        assert!(!schedule_due("0 9 * * 1", "Not/A_Zone", a, b));
        // Sanity: a real daily cron IS due across a full day.
        assert!(schedule_due("0 9 * * *", "America/New_York", a, b));
    }

    #[test]
    fn a_malformed_agent_does_not_silence_the_others() {
        let json = serde_json::json!({
            "schema_version": 1,
            "agents": [
                { "nonsense": true },
                {
                    "agent_id": "a-2",
                    "name": "ok",
                    "state": "active",
                    "versions": [{ "spec": { "trigger": context_trigger() } }]
                }
            ]
        })
        .to_string();
        let records = parse_agents(&json);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].agent_id, "a-2");
    }

    #[test]
    fn matching_is_exact_never_suffix() {
        let records = parse_agents(&agents_json("shadow", context_trigger()));
        let r = &records[0];
        assert!(matches(
            r,
            &ContextFields { app_category: "browser", object_type: "contact", domain: Some("acme.example") }
        ));
        // The lookalike-host attack the actuation allowlist also refuses.
        assert!(!matches(
            r,
            &ContextFields {
                app_category: "browser",
                object_type: "contact",
                domain: Some("acme.example.evil.test")
            }
        ));
        // THE #3 FIX: an origin-scoped trigger fires regardless of the coarse
        // app_category the ingest categorizer assigned. The compiler stamps
        // "browser"; ingest maps acme.example → "crm"; the ORIGIN is the precise
        // selector, so this now MATCHES where it used to be rejected forever.
        assert!(matches(
            r,
            &ContextFields { app_category: "crm", object_type: "contact", domain: Some("acme.example") }
        ));
        // object_type is still checked when the trigger names one.
        assert!(!matches(
            r,
            &ContextFields { app_category: "browser", object_type: "invoice", domain: Some("acme.example") }
        ));
        // A domain-less context (the lane could not read the page identity)
        // falls back to the CATEGORY comparison rather than a flat refusal —
        // the trigger's own category still gates it…
        assert!(matches(
            r,
            &ContextFields { app_category: "browser", object_type: "contact", domain: None }
        ));
        // …so the wrong kind of work still cannot wake it.
        assert!(!matches(
            r,
            &ContextFields { app_category: "email", object_type: "contact", domain: None }
        ));
    }

    #[test]
    fn a_triggerless_of_origin_still_matches_on_category() {
        // Without an origin (native/legacy triggers), app_category remains the
        // selector — the #3 fix narrows to origin-bearing triggers only.
        let json = agents_json(
            "shadow",
            serde_json::json!({
                "type": "context",
                "app_category": "crm",
                "object_type": "contact",
                "cooldown_seconds": 300
            }),
        );
        let records = parse_agents(&json);
        let r = &records[0];
        assert!(matches(
            r,
            &ContextFields { app_category: "crm", object_type: "contact", domain: None }
        ));
        assert!(!matches(
            r,
            &ContextFields { app_category: "browser", object_type: "contact", domain: None }
        ));
    }

    #[test]
    fn unparseable_json_yields_no_triggers_rather_than_a_panic() {
        assert!(parse_agents("{not json").is_empty());
        assert!(parse_agents("{}").is_empty());
    }
}
