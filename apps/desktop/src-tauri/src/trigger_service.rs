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

/// The redacted context fields evaluation needs.
pub struct ContextFields<'a> {
    pub app_category: &'a str,
    pub object_type: &'a str,
    pub domain: Option<&'a str>,
}

#[derive(Default)]
struct Inner {
    records: Vec<TriggerRecord>,
    last_fired: HashMap<String, Instant>,
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
        if trigger.get("type").and_then(|t| t.as_str()) != Some("context") {
            continue;
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

/// Does this context wake this trigger? Pure; exact comparisons only.
pub fn matches(record: &TriggerRecord, ctx: &ContextFields<'_>) -> bool {
    if record.app_category != ctx.app_category {
        return false;
    }
    if let Some(object_type) = &record.object_type {
        if object_type != ctx.object_type {
            return false;
        }
    }
    if let Some(host) = &record.origin_host {
        match ctx.domain {
            Some(domain) if domain == host => {}
            _ => return false,
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
    let state = app.state::<TriggerServiceState>();
    let mut inner = state.0.lock().expect("trigger state poisoned");
    inner.records = records;
    // Drop cooldown history for agents that no longer exist; the survivors keep
    // theirs, so re-saving the file cannot reset every cooldown at once.
    let keep: Vec<String> = inner.records.iter().map(|r| r.agent_id.clone()).collect();
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
        let firing = Firing {
            agent_id: &agent_id,
            agent_name: &agent_name,
            at: &occurred_at,
            context,
        };
        let _ = app.emit(
            "maman-app-events",
            serde_json::json!({ "type": "agent_trigger_fired", "firing": &firing }),
        );
        // The status bar is a separate window and survives the panel closing —
        // this beat is what makes a daemon firing VISIBLE with no panel open.
        let _ = app.emit(
            "maman-app-events",
            serde_json::json!({
                "type": "status_beat",
                "beat": { "kind": "running", "title": agent_name, "phase": "reading" }
            }),
        );
        append_staged(app, &firing);
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
    fn manual_and_schedule_triggers_are_not_the_daemon_s_business() {
        assert!(
            parse_agents(&agents_json("shadow", serde_json::json!({ "type": "manual" })))
                .is_empty()
        );
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
        assert!(!matches(
            r,
            &ContextFields { app_category: "crm", object_type: "contact", domain: Some("acme.example") }
        ));
        assert!(!matches(
            r,
            &ContextFields { app_category: "browser", object_type: "invoice", domain: Some("acme.example") }
        ));
        // A trigger that names a host does not fire for an event with none.
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
