//! Maman desktop core.
//!
//! Trust boundary: the webview is untrusted relative to this Rust core.
//! Commands validate their inputs, and window-sensitive commands check the
//! calling window's label (the pet window may never reach privileged surfaces).

pub mod browser_bridge;
pub mod domain;
pub mod observer;
pub mod redaction;
pub mod store;
pub mod sync;

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, Runtime, WebviewWindow, Window};
use tokio::sync::Mutex;

use store::{KeychainKeyProvider, LocalStore, TimelineEntry};

const EDGE_SNAP_PX: i32 = 16;
const EDGE_SNAP_THRESHOLD_PX: i32 = 40;
const SETTINGS_FILE: &str = "settings.json";
const POSITIONS_FILE: &str = "pet-positions.json";
const KEYCHAIN_SERVICE: &str = "com.maman.desktop.keys";
const KEYCHAIN_ACCOUNT: &str = "local-store-key";
/// Device token lives ONLY in the keychain — never in the webview or settings.
const KEYCHAIN_DEVICE_TOKEN_ACCOUNT: &str = "device-token";
const SYNC_INTERVAL_SECS: u64 = 60;

/// Seeded demo identity (dev auth). These are WorkOS ids, not secrets; they live
/// here as the single source of truth so the webview never hardcodes them.
const DEMO_ORG_WORKOS_ID: &str = "org_demo_acme_sales";
const DEMO_USER_WORKOS_ID: &str = "user_demo_alex";

/// API base URL for device→server calls. Overridable for local/hosted targets.
fn api_base_url() -> String {
    std::env::var("MAMAN_API_BASE_URL").unwrap_or_else(|_| "http://localhost:4000".to_string())
}

/// Managed state: the encrypted local store (initialized on first use).
pub struct StoreState(pub Mutex<Option<LocalStore>>);

/// Lazily initializes and returns the store guard. Callers keep the guard for
/// the duration of their operation (the mutex serializes store access).
async fn store_guard<'a, R: Runtime>(
    app: &AppHandle<R>,
    state: &'a StoreState,
) -> Result<tokio::sync::MutexGuard<'a, Option<LocalStore>>, String> {
    let mut guard = state.0.lock().await;
    if guard.is_none() {
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("data dir unavailable: {e}"))?;
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let provider = KeychainKeyProvider {
            service: KEYCHAIN_SERVICE.to_string(),
            account: KEYCHAIN_ACCOUNT.to_string(),
        };
        // Domain packs for the L1 classifier. Resolved from the bundled resource
        // dir, falling back to the repo checkout in dev. Missing packs are fine:
        // nothing gets classified and observation is unaffected.
        let packs = domain::load_packs(&domain_packs_dir(app));
        let store = LocalStore::open_with_packs(
            &dir.join("maman-local.sqlite"),
            &provider,
            "local-user",
            packs,
        )
        .await
        .map_err(|e| format!("store open failed: {e}"))?;
        *guard = Some(store);
    }
    Ok(guard)
}

/// Settings snapshot the gating logic needs (parsed from the settings JSON).
#[derive(Default)]
struct GateSettings {
    observation_paused: bool,
    private_apps: Vec<String>,
    allowlist_domains: Vec<String>,
    /// Desktop app bundle ids the macOS AX observer may observe. Without this the
    /// Swift observer's decideObservation drops every native-app event.
    allowlist_bundles: Vec<String>,
    /// The user's explicit "observe every app (except always-off ones)" opt-in.
    /// When true the observer receives the "*" wildcard; hard-deny / private /
    /// secure-field boundaries still apply first, so sensitive contexts are
    /// never observed.
    observe_all_apps: bool,
}

fn load_gate_settings<R: Runtime>(app: &AppHandle<R>) -> GateSettings {
    let Ok(path) = config_path(app, SETTINGS_FILE) else {
        return GateSettings { observation_paused: true, ..Default::default() };
    };
    let Ok(raw) = fs::read_to_string(path) else {
        return GateSettings { observation_paused: true, ..Default::default() };
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return GateSettings { observation_paused: true, ..Default::default() };
    };
    GateSettings {
        observation_paused: json
            .get("observation_paused")
            .and_then(|v| v.as_bool())
            .unwrap_or(true),
        private_apps: json
            .get("private_apps")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default(),
        allowlist_domains: json
            .get("allowlist_domains")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default(),
        allowlist_bundles: json
            .get("allowlist_bundles")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default(),
        observe_all_apps: json
            .get("observe_all_apps")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
    }
}

/// The observer `configure` control line for the current settings. Sent at
/// spawn and re-sent whenever it changes so the running sidecar picks up a new
/// allowlist / observe-all / private-apps config LIVE (no restart). The exact
/// string doubles as a change fingerprint. "Observe every app" sends the "*"
/// wildcard; the Swift observer's hard-deny / private / secure-field boundaries
/// still run first.
fn observer_configure_line(settings: &GateSettings) -> String {
    let bundles: Vec<String> = if settings.observe_all_apps {
        vec!["*".to_string()]
    } else {
        settings.allowlist_bundles.clone()
    };
    serde_json::json!({
        "type": "configure",
        "allowlist_bundles": bundles,
        "allowlist_domains": settings.allowlist_domains,
        "private_apps": settings.private_apps,
    })
    .to_string()
}

/// Central ingest gate (spec §10): decides whether an event may be persisted.
/// Returns Ok(None) to persist, Ok(Some(reason)) to drop/boundary, Err on abuse.
fn gate_event(settings: &GateSettings, event: &serde_json::Value) -> Result<Option<String>, String> {
    if settings.observation_paused {
        return Ok(Some("observation_paused".into()));
    }
    let display = event
        .pointer("/app/display_name")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let domain = event.pointer("/app/domain").and_then(|v| v.as_str());
    let identity = format!("{display} {}", domain.unwrap_or(""));
    if redaction::is_hard_denied(&identity) {
        return Ok(Some("hard_denied".into()));
    }
    if redaction::is_user_denied(&identity, &settings.private_apps) {
        return Ok(Some("user_private".into()));
    }
    // Allowlist: browser events require an allowlisted domain. Demo source is
    // exempt only when it carries an allowlisted or generic fixture domain.
    if let Some(d) = domain {
        // Exact host or a subdomain of an allowlisted host ONLY. The looser
        // `a.ends_with(d)` / `d.contains(a)` forms wrongly admitted lookalikes
        // (e.g. "force.com" or "evil-salesforce.com.attacker.com").
        let allowed = settings
            .allowlist_domains
            .iter()
            .any(|a| d == a || d.ends_with(&format!(".{a}")));
        let source = event.get("source").and_then(|v| v.as_str()).unwrap_or("");
        if !allowed && source == "chrome" {
            return Ok(Some("not_allowlisted".into()));
        }
    }
    Ok(None)
}

/// Where compiled domain packs live: the bundled resource dir in a packaged app,
/// else the repo checkout so `tauri dev` works without a build step.
fn domain_packs_dir<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    if let Ok(resource) = app.path().resource_dir() {
        let bundled = resource.join("domain/packs");
        if bundled.is_dir() {
            return bundled;
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../domain/packs")
}

/// Loaded domains, their counts, and classifier coverage over the last 7 days.
/// Panel-only: it reports on observation data.
#[tauri::command]
async fn packs_status<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    state: tauri::State<'_, StoreState>,
) -> Result<serde_json::Value, String> {
    require_panel(&window)?;
    let guard = store_guard(&app, &state).await?;
    let store = guard.as_ref().expect("initialized");
    let coverage = store
        .classifier_coverage(7)
        .await
        .map_err(|e| format!("coverage query failed: {e}"))?;
    Ok(serde_json::json!({
        "packs": domain::pack_status(store.packs()),
        "classified_last_7_days": coverage.0,
        "events_last_7_days": coverage.1,
        "coverage_pct": if coverage.1 == 0 { 0.0 } else {
            (coverage.0 as f64 / coverage.1 as f64 * 1000.0).round() / 10.0
        },
    }))
}

fn config_path<R: Runtime>(app: &AppHandle<R>, file: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("config dir unavailable: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create config dir: {e}"))?;
    Ok(dir.join(file))
}

// ---------- settings (JSON at M2; encrypted SQLite arrives at M3) ----------

#[tauri::command]
fn settings_load<R: Runtime>(app: AppHandle<R>) -> Result<Option<String>, String> {
    let path = config_path(&app, SETTINGS_FILE)?;
    match fs::read_to_string(&path) {
        Ok(contents) => Ok(Some(contents)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("settings read failed: {e}")),
    }
}

#[tauri::command]
fn settings_save<R: Runtime>(app: AppHandle<R>, json: String) -> Result<(), String> {
    // Validate it is JSON at all before persisting; schema lives in TypeScript.
    serde_json::from_str::<serde_json::Value>(&json).map_err(|e| format!("invalid JSON: {e}"))?;
    if json.len() > 64 * 1024 {
        return Err("settings payload too large".into());
    }
    let path = config_path(&app, SETTINGS_FILE)?;
    fs::write(&path, json).map_err(|e| format!("settings write failed: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

// ---------- pet position persistence (per display) ----------

#[derive(Serialize, Deserialize, Default)]
struct PetPositions(HashMap<String, (i32, i32)>);

fn load_positions<R: Runtime>(app: &AppHandle<R>) -> PetPositions {
    config_path(app, POSITIONS_FILE)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_positions<R: Runtime>(app: &AppHandle<R>, positions: &PetPositions) {
    if let Ok(path) = config_path(app, POSITIONS_FILE) {
        if let Ok(json) = serde_json::to_string(positions) {
            let _ = fs::write(path, json);
        }
    }
}

fn monitor_key<R: Runtime>(window: &WebviewWindow<R>) -> String {
    window
        .current_monitor()
        .ok()
        .flatten()
        .and_then(|m| m.name().cloned())
        .unwrap_or_else(|| "primary".to_string())
}

/// Snaps a pet position to EDGE_SNAP_PX from a display edge when it settles nearby.
fn snap_to_edges(pos: (i32, i32), size: (u32, u32), bounds: (i32, i32, u32, u32)) -> (i32, i32) {
    let (mut x, mut y) = pos;
    let (w, h) = (size.0 as i32, size.1 as i32);
    let (bx, by, bw, bh) = (bounds.0, bounds.1, bounds.2 as i32, bounds.3 as i32);

    if (x - bx).abs() < EDGE_SNAP_THRESHOLD_PX {
        x = bx + EDGE_SNAP_PX;
    } else if ((bx + bw) - (x + w)).abs() < EDGE_SNAP_THRESHOLD_PX {
        x = bx + bw - w - EDGE_SNAP_PX;
    }
    if (y - by).abs() < EDGE_SNAP_THRESHOLD_PX {
        y = by + EDGE_SNAP_PX;
    } else if ((by + bh) - (y + h)).abs() < EDGE_SNAP_THRESHOLD_PX {
        y = by + bh - h - EDGE_SNAP_PX;
    }
    // Always keep the pet fully on screen.
    x = x.clamp(bx, bx + bw - w);
    y = y.clamp(by, by + bh - h);
    (x, y)
}

fn persist_and_snap_pet<R: Runtime>(app: &AppHandle<R>) {
    let Some(pet) = app.get_webview_window("pet") else { return };
    let (Ok(pos), Ok(size)) = (pet.outer_position(), pet.outer_size()) else { return };
    let Ok(Some(monitor)) = pet.current_monitor() else { return };

    let bounds = (
        monitor.position().x,
        monitor.position().y,
        monitor.size().width,
        monitor.size().height,
    );
    let snapped = snap_to_edges((pos.x, pos.y), (size.width, size.height), bounds);
    if snapped != (pos.x, pos.y) {
        let _ = pet.set_position(PhysicalPosition::new(snapped.0, snapped.1));
    }
    let mut positions = load_positions(app);
    positions.0.insert(monitor_key(&pet), snapped);
    save_positions(app, &positions);
}

/// Makes Maman present on EVERY macOS Space (virtual desktop) and full-screen
/// Space: the pet stays visible and observing when you swipe between desktops,
/// and the panel opens on whichever desktop is active instead of yanking you
/// back to the one it was created on. Observation itself already spans Spaces
/// (the frontmost-app change that a Space switch triggers is what the observer
/// tracks); this only fixes window presence.
fn make_windows_visible_on_all_spaces<R: Runtime>(app: &AppHandle<R>) {
    for label in ["pet", "panel"] {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.set_visible_on_all_workspaces(true);
        }
    }
}

fn restore_pet_position<R: Runtime>(app: &AppHandle<R>) {
    let Some(pet) = app.get_webview_window("pet") else { return };
    let positions = load_positions(app);
    let key = monitor_key(&pet);
    if let Some(&(x, y)) = positions.0.get(&key) {
        let _ = pet.set_position(PhysicalPosition::new(x, y));
    } else if let (Ok(Some(monitor)), Ok(size)) = (pet.current_monitor(), pet.outer_size()) {
        // Default: lower-right corner, snapped 16px from the edges.
        let x = monitor.position().x + monitor.size().width as i32
            - size.width as i32
            - EDGE_SNAP_PX;
        let y = monitor.position().y + monitor.size().height as i32
            - size.height as i32
            - EDGE_SNAP_PX
            - 24; // clear the Dock area slightly
        let _ = pet.set_position(PhysicalPosition::new(x, y));
    }
}

// ---------- panel management ----------

fn position_panel_near_pet<R: Runtime>(app: &AppHandle<R>) {
    let (Some(pet), Some(panel)) = (
        app.get_webview_window("pet"),
        app.get_webview_window("panel"),
    ) else {
        return;
    };
    let (Ok(pet_pos), Ok(pet_size), Ok(panel_size)) =
        (pet.outer_position(), pet.outer_size(), panel.outer_size())
    else {
        return;
    };
    let Ok(Some(monitor)) = pet.current_monitor() else { return };

    let (bx, by) = (monitor.position().x, monitor.position().y);
    let (bw, bh) = (monitor.size().width as i32, monitor.size().height as i32);
    let (pw, ph) = (panel_size.width as i32, panel_size.height as i32);

    // Prefer opening to the left of the pet, bottoms aligned.
    let mut x = pet_pos.x - pw - 12;
    let mut y = pet_pos.y + pet_size.height as i32 - ph;
    if x < bx + 8 {
        x = pet_pos.x + pet_size.width as i32 + 12; // fall back to the right side
    }
    x = x.clamp(bx + 8, bx + bw - pw - 8);
    y = y.clamp(by + 8, by + bh - ph - 8);
    let _ = panel.set_position(PhysicalPosition::new(x, y));
}

/// Windows that are hideable surfaces rather than document windows: closing
/// them must HIDE, never destroy. A destroyed window is gone from
/// `get_webview_window`, so every later open path (pet click, global shortcut,
/// tray) silently no-ops until the app restarts.
fn hides_on_close(label: &str) -> bool {
    label == "panel"
}

fn toggle_panel_impl<R: Runtime>(app: &AppHandle<R>) {
    let Some(panel) = app.get_webview_window("panel") else { return };
    if panel.is_visible().unwrap_or(false) {
        let _ = panel.hide();
    } else {
        position_panel_near_pet(app);
        let _ = panel.show();
        let _ = panel.set_focus();
    }
}

#[tauri::command]
fn toggle_panel<R: Runtime>(app: AppHandle<R>) {
    toggle_panel_impl(&app);
}

#[tauri::command]
fn hide_panel<R: Runtime>(app: AppHandle<R>) {
    if let Some(panel) = app.get_webview_window("panel") {
        let _ = panel.hide();
    }
}

#[tauri::command]
fn quit_app<R: Runtime>(app: AppHandle<R>) {
    app.exit(0);
}

// ---------- local encrypted event store commands ----------
// Privileged store commands are PANEL-ONLY: the pet window is rejected by
// window-label check (trust boundary; see capabilities/*.json for the rest).

fn require_panel<R: Runtime>(window: &Window<R>) -> Result<(), String> {
    if window.label() != "panel" {
        return Err("store commands are panel-only".into());
    }
    Ok(())
}

/// Ingests a batch of WorkflowEvents through the full gate → redact → encrypt
/// pipeline. Returns per-batch counts. Used by the demo observer today and the
/// real observer bridge at M4.
#[derive(Serialize)]
pub struct IngestResult {
    pub stored: u32,
    pub dropped_paused: u32,
    pub dropped_denied: u32,
    pub dropped_not_allowlisted: u32,
    pub boundary_events: u32,
    pub rejected_forbidden: u32,
}

#[tauri::command]
async fn events_ingest<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    state: tauri::State<'_, StoreState>,
    events_json: String,
) -> Result<IngestResult, String> {
    require_panel(&window)?;
    if events_json.len() > 8 * 1024 * 1024 {
        return Err("batch too large".into());
    }
    let events: Vec<serde_json::Value> =
        serde_json::from_str(&events_json).map_err(|e| format!("invalid batch JSON: {e}"))?;
    let settings = load_gate_settings(&app);
    let guard = store_guard(&app, &state).await?;
    let store = guard.as_ref().expect("initialized");

    let mut result = IngestResult {
        stored: 0,
        dropped_paused: 0,
        dropped_denied: 0,
        dropped_not_allowlisted: 0,
        boundary_events: 0,
        rejected_forbidden: 0,
    };

    let mut denied_boundary_emitted = false;
    for event in &events {
        match gate_event(&settings, event)? {
            None => match store.insert_event(event, store::EVENT_RETENTION_DAYS_DEFAULT).await {
                Ok(_) => result.stored += 1,
                Err(store::StoreError::ForbiddenField(_)) => result.rejected_forbidden += 1,
                Err(e) => return Err(e.to_string()),
            },
            Some(reason) => match reason.as_str() {
                "observation_paused" => result.dropped_paused += 1,
                "not_allowlisted" => result.dropped_not_allowlisted += 1,
                _ => {
                    result.dropped_denied += 1;
                    // Denied context: at most ONE boundary_redacted event, with
                    // no application identity.
                    if !denied_boundary_emitted {
                        denied_boundary_emitted = true;
                        let boundary = serde_json::json!({
                            "schema_version": 1,
                            "event_id": event.get("event_id").cloned().unwrap_or_default(),
                            "device_id": event.get("device_id").cloned().unwrap_or_default(),
                            "user_id": event.get("user_id").cloned().unwrap_or_default(),
                            "organization_id": event.get("organization_id").cloned().unwrap_or_default(),
                            "occurred_at": event.get("occurred_at").cloned().unwrap_or_default(),
                            "monotonic_ms": event.get("monotonic_ms").cloned().unwrap_or_default(),
                            "source": event.get("source").cloned().unwrap_or_default(),
                            "app": { "display_name": "Private" },
                            "event_type": "boundary_redacted",
                            "target": {},
                            "context": {},
                            "sensitivity": "restricted",
                            "redaction": { "applied": true, "reasons": [reason] }
                        });
                        if store
                            .insert_event(&boundary, store::EVENT_RETENTION_DAYS_DEFAULT)
                            .await
                            .is_ok()
                        {
                            result.boundary_events += 1;
                        }
                    }
                }
            },
        }
    }
    record_observation_stats(&app, &result);
    Ok(result)
}

/// Weekly counters of what was — and pointedly was NOT — collected. Counts
/// only, never content. Backs the "What Maman sees" trust surface: showing the
/// drop reasons (paused / denied / not allowed) is how the worker verifies the
/// boundaries are real.
const STATS_FILE: &str = "observation-stats.json";

fn week_start_iso() -> String {
    // Monday of the current UTC week, date only.
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    let days_since_epoch = now_ms / 86_400_000;
    // 1970-01-01 was a Thursday → Monday offset 3.
    let monday = days_since_epoch - ((days_since_epoch + 3).rem_euclid(7));
    store::iso_from_unix_ms(monday * 86_400_000)[..10].to_string()
}

fn record_observation_stats<R: Runtime>(app: &AppHandle<R>, result: &IngestResult) {
    let Ok(path) = config_path(app, STATS_FILE) else { return };
    let week = week_start_iso();
    let mut stats: serde_json::Value = fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if stats.get("week_start").and_then(|v| v.as_str()) != Some(week.as_str()) {
        stats = serde_json::json!({ "week_start": week });
    }
    let mut bump = |key: &str, by: u32| {
        let cur = stats.get(key).and_then(|v| v.as_u64()).unwrap_or(0);
        stats[key] = serde_json::json!(cur + by as u64);
    };
    bump("stored", result.stored);
    bump("dropped_paused", result.dropped_paused);
    bump("dropped_denied", result.dropped_denied);
    bump("dropped_not_allowlisted", result.dropped_not_allowlisted);
    bump("boundary_events", result.boundary_events);
    bump("rejected_forbidden", result.rejected_forbidden);
    let _ = fs::write(&path, stats.to_string());
}

/// This week's observation counters (what was stored vs deliberately dropped).
#[tauri::command]
fn observation_stats<R: Runtime>(app: AppHandle<R>) -> serde_json::Value {
    let empty = serde_json::json!({
        "week_start": week_start_iso(),
        "stored": 0, "dropped_paused": 0, "dropped_denied": 0,
        "dropped_not_allowlisted": 0, "boundary_events": 0, "rejected_forbidden": 0,
    });
    let Ok(path) = config_path(&app, STATS_FILE) else { return empty };
    let stats: Option<serde_json::Value> =
        fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str(&s).ok());
    match stats {
        Some(s) if s.get("week_start").and_then(|v| v.as_str()) == Some(&week_start_iso()) => s,
        _ => empty,
    }
}

#[tauri::command]
async fn events_timeline<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    state: tauri::State<'_, StoreState>,
    limit: i64,
    offset: i64,
) -> Result<Vec<TimelineEntry>, String> {
    require_panel(&window)?;
    let guard = store_guard(&app, &state).await?;
    guard
        .as_ref()
        .expect("initialized")
        .timeline(limit.clamp(1, 500), offset.max(0))
        .await
        .map_err(|e| e.to_string())
}

/// Pattern-engine projection (spec: the webview may receive this projection
/// but never bulk decrypted WorkflowEvent payloads).
#[tauri::command]
async fn events_pattern_features<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    state: tauri::State<'_, StoreState>,
    limit: i64,
) -> Result<Vec<serde_json::Value>, String> {
    require_panel(&window)?;
    let guard = store_guard(&app, &state).await?;
    guard
        .as_ref()
        .expect("initialized")
        .pattern_features(limit.clamp(1, 10_000))
        .await
        .map_err(|e| e.to_string())
}

/// Whether the Browser Relay has completed pairing (a shared secret exists).
/// Exposes ONLY a boolean — never key material.
#[tauri::command]
fn browser_relay_paired() -> bool {
    keyring::Entry::new(KEYCHAIN_SERVICE, browser_bridge::BROWSER_SECRET_ACCOUNT)
        .and_then(|e| e.get_password())
        .is_ok()
}

/// Local agent persistence (drafts + immutable versions; demo/local mode).
#[tauri::command]
fn agents_load<R: Runtime>(app: AppHandle<R>) -> Result<Option<String>, String> {
    let path = config_path(&app, "agents.json")?;
    match fs::read_to_string(&path) {
        Ok(contents) => Ok(Some(contents)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read failed: {e}")),
    }
}

#[tauri::command]
fn agents_save<R: Runtime>(app: AppHandle<R>, json: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&json).map_err(|e| format!("invalid JSON: {e}"))?;
    if json.len() > 4 * 1024 * 1024 {
        return Err("payload too large".into());
    }
    let path = config_path(&app, "agents.json")?;
    fs::write(&path, json).map_err(|e| format!("write failed: {e}"))?;
    Ok(())
}

/// Suggestion-state persistence (statuses, snoozes, suppressions, budget).
#[tauri::command]
fn suggestions_load<R: Runtime>(app: AppHandle<R>) -> Result<Option<String>, String> {
    let path = config_path(&app, "suggestions.json")?;
    match fs::read_to_string(&path) {
        Ok(contents) => Ok(Some(contents)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read failed: {e}")),
    }
}

#[tauri::command]
fn suggestions_save<R: Runtime>(app: AppHandle<R>, json: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&json).map_err(|e| format!("invalid JSON: {e}"))?;
    if json.len() > 256 * 1024 {
        return Err("payload too large".into());
    }
    let path = config_path(&app, "suggestions.json")?;
    fs::write(&path, json).map_err(|e| format!("write failed: {e}"))?;
    Ok(())
}

#[tauri::command]
async fn events_delete<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    state: tauri::State<'_, StoreState>,
    event_id: String,
) -> Result<bool, String> {
    require_panel(&window)?;
    let guard = store_guard(&app, &state).await?;
    guard
        .as_ref()
        .expect("initialized")
        .delete_event(&event_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn events_delete_all<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    state: tauri::State<'_, StoreState>,
) -> Result<u64, String> {
    require_panel(&window)?;
    let guard = store_guard(&app, &state).await?;
    guard
        .as_ref()
        .expect("initialized")
        .delete_all_events()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn events_delete_app<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    state: tauri::State<'_, StoreState>,
    display_name: String,
) -> Result<u64, String> {
    require_panel(&window)?;
    let guard = store_guard(&app, &state).await?;
    guard
        .as_ref()
        .expect("initialized")
        .delete_app_history(&display_name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn events_set_excluded<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    state: tauri::State<'_, StoreState>,
    event_id: String,
    excluded: bool,
) -> Result<bool, String> {
    require_panel(&window)?;
    let guard = store_guard(&app, &state).await?;
    guard
        .as_ref()
        .expect("initialized")
        .set_excluded_from_learning(&event_id, excluded)
        .await
        .map_err(|e| e.to_string())
}

// ---------- replay verification (two-tier local data; panel-only) ----------

/// Persists replay-fidelity traces. LOCAL-ONLY: nothing here touches the sync
/// outbox — traces are richer than any synced projection and never leave the
/// device (see the episode_traces schema comment).
#[tauri::command]
async fn traces_save<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    state: tauri::State<'_, StoreState>,
    traces: Vec<serde_json::Value>,
) -> Result<u64, String> {
    require_panel(&window)?;
    if traces.len() > 500 {
        return Err("trace batch too large".into());
    }
    let guard = store_guard(&app, &state).await?;
    guard
        .as_ref()
        .expect("initialized")
        .traces_save(&traces)
        .await
        .map_err(|e| e.to_string())
}

/// The most recent recorded runs for a pattern (decrypted, newest first).
#[tauri::command]
async fn traces_for_pattern<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    state: tauri::State<'_, StoreState>,
    signature: String,
    limit: i64,
) -> Result<Vec<serde_json::Value>, String> {
    require_panel(&window)?;
    let guard = store_guard(&app, &state).await?;
    guard
        .as_ref()
        .expect("initialized")
        .traces_for_pattern(&signature, limit)
        .await
        .map_err(|e| e.to_string())
}

/// Upserts computed pattern candidates so every number the card shows traces
/// to a real row in pattern_candidates.
#[tauri::command]
async fn patterns_upsert<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    state: tauri::State<'_, StoreState>,
    candidates: Vec<serde_json::Value>,
) -> Result<u64, String> {
    require_panel(&window)?;
    let guard = store_guard(&app, &state).await?;
    let store = guard.as_ref().expect("initialized");
    let mut saved = 0u64;
    for c in &candidates {
        let (Some(id), Some(status), Some(score), Some(first), Some(last)) = (
            c.get("pattern_id").and_then(|v| v.as_str()),
            c.get("status").and_then(|v| v.as_str()),
            c.get("opportunity_score").and_then(|v| v.as_f64()),
            c.get("first_seen_at").and_then(|v| v.as_str()),
            c.get("last_seen_at").and_then(|v| v.as_str()),
        ) else {
            continue;
        };
        store
            .candidate_upsert(id, status, score, first, last, c)
            .await
            .map_err(|e| e.to_string())?;
        saved += 1;
    }
    Ok(saved)
}

/// Records a replay-verification outcome on the candidate row.
#[tauri::command]
async fn pattern_verification_save<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    state: tauri::State<'_, StoreState>,
    pattern_id: String,
    runs_tested: i64,
    runs_matched: i64,
    detail: serde_json::Value,
) -> Result<bool, String> {
    require_panel(&window)?;
    let guard = store_guard(&app, &state).await?;
    guard
        .as_ref()
        .expect("initialized")
        .candidate_verification_save(&pattern_id, runs_tested, runs_matched, &detail)
        .await
        .map_err(|e| e.to_string())
}

/// Card-ready verification report: "tested N, matched M, diverged at step X".
#[tauri::command]
async fn verification_report<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    state: tauri::State<'_, StoreState>,
    pattern_id: String,
) -> Result<Option<serde_json::Value>, String> {
    require_panel(&window)?;
    let guard = store_guard(&app, &state).await?;
    guard
        .as_ref()
        .expect("initialized")
        .verification_report(&pattern_id)
        .await
        .map_err(|e| e.to_string())
}

/// Appends a suggestion action to the local suggestion_history ledger.
#[tauri::command]
async fn suggestion_history_log<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    state: tauri::State<'_, StoreState>,
    pattern_id: String,
    action: String,
    reason: Option<String>,
) -> Result<(), String> {
    require_panel(&window)?;
    let guard = store_guard(&app, &state).await?;
    guard
        .as_ref()
        .expect("initialized")
        .suggestion_history_log(&pattern_id, &action, reason.as_deref())
        .await
        .map_err(|e| e.to_string())
}

// ---------- trust surface (panel-only) ----------

/// Non-mutating peek at the next queued sync payloads, decrypted, so the user
/// can see for themselves exactly what would leave this device.
#[tauri::command]
async fn sync_preview<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    state: tauri::State<'_, StoreState>,
    limit: i64,
) -> Result<Vec<serde_json::Value>, String> {
    require_panel(&window)?;
    let guard = store_guard(&app, &state).await?;
    guard
        .as_ref()
        .expect("initialized")
        .outbox_peek(limit)
        .await
        .map_err(|e| e.to_string())
}

/// The hard-denied contexts, verbatim from the code that enforces them —
/// structurally incapable of being observed, not a policy toggle.
#[tauri::command]
fn hard_denied_list() -> Vec<String> {
    redaction::HARD_DENY_SUBSTRINGS.iter().map(|s| s.to_string()).collect()
}

// ---------- browser extension pairing + socket bridge ----------

const PAIRING_FILE: &str = "browser-pairing.json";

/// Panel-only: starts a pairing session. Only the token HASH is stored; the
/// plaintext token is shown once in the panel for the user to paste into the
/// extension, and expires after five minutes.
#[tauri::command]
fn pairing_begin<R: Runtime>(app: AppHandle<R>, window: Window<R>) -> Result<String, String> {
    require_panel(&window)?;
    let mut token_bytes = [0u8; 32];
    use rand::RngCore;
    rand::thread_rng().fill_bytes(&mut token_bytes);
    let token = browser_bridge::base64url_encode(&token_bytes);
    let pending = browser_bridge::PendingPairing {
        token_sha256: browser_bridge::sha256_hex(token.as_bytes()),
        expires_at_ms: browser_bridge::now_unix_ms() + browser_bridge::PAIRING_TOKEN_TTL_MS,
    };
    let path = config_path(&app, PAIRING_FILE)?;
    fs::write(&path, serde_json::to_string(&pending).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    Ok(token)
}

fn socket_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("data dir unavailable: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("browser-host.sock"))
}

/// Handles one JSON-line request from the native host. Pure enough to test:
/// all effects flow through the provided closures.
fn handle_bridge_request<R: Runtime>(
    app: &AppHandle<R>,
    request: &serde_json::Value,
) -> serde_json::Value {
    match request.get("type").and_then(|v| v.as_str()) {
        Some("pair_check") => {
            let Some(token) = request.get("token").and_then(|v| v.as_str()) else {
                return serde_json::json!({"ok": false, "error": "missing token"});
            };
            let Ok(path) = config_path(app, PAIRING_FILE) else {
                return serde_json::json!({"ok": false, "error": "no pairing pending"});
            };
            let Ok(raw) = fs::read_to_string(&path) else {
                return serde_json::json!({"ok": false, "error": "no pairing pending"});
            };
            let Ok(pending) = serde_json::from_str::<browser_bridge::PendingPairing>(&raw) else {
                return serde_json::json!({"ok": false, "error": "no pairing pending"});
            };
            if browser_bridge::now_unix_ms() > pending.expires_at_ms {
                let _ = fs::remove_file(&path);
                return serde_json::json!({"ok": false, "error": "pairing token expired"});
            }
            if browser_bridge::sha256_hex(token.as_bytes()) != pending.token_sha256 {
                return serde_json::json!({"ok": false, "error": "pairing token mismatch"});
            }
            // Consume the token, mint and store the long-lived shared secret.
            let _ = fs::remove_file(&path);
            let mut secret = [0u8; 32];
            use rand::RngCore;
            rand::thread_rng().fill_bytes(&mut secret);
            let secret_b64 = browser_bridge::base64url_encode(&secret);
            match keyring::Entry::new(KEYCHAIN_SERVICE, browser_bridge::BROWSER_SECRET_ACCOUNT)
                .and_then(|e| e.set_password(&secret_b64).map(|_| ()))
            {
                Ok(()) => serde_json::json!({"ok": true, "shared_secret": secret_b64}),
                Err(e) => serde_json::json!({"ok": false, "error": format!("keychain: {e}")}),
            }
        }
        Some("envelope") => {
            let Some(envelope) = request.get("envelope") else {
                return serde_json::json!({"ok": false, "error": "missing envelope"});
            };
            let Ok(secret) =
                keyring::Entry::new(KEYCHAIN_SERVICE, browser_bridge::BROWSER_SECRET_ACCOUNT)
                    .and_then(|e| e.get_password())
            else {
                return serde_json::json!({"ok": false, "error": "not paired"});
            };
            if !browser_bridge::verify_envelope_hmac(envelope, &secret) {
                return serde_json::json!({"ok": false, "error": "bad signature"});
            }
            let payload = envelope.get("payload").cloned().unwrap_or_default();
            if payload.get("type").and_then(|v| v.as_str()) != Some("semantic_event") {
                return serde_json::json!({"ok": false, "error": "unsupported payload"});
            }
            let Some(shape) = payload.get("event") else {
                return serde_json::json!({"ok": false, "error": "missing event"});
            };
            let event_id = format!(
                "{}",
                uuid_v4_like(&browser_bridge::sha256_hex(
                    serde_json::to_string(shape).unwrap_or_default().as_bytes()
                ))
            );
            let Some(event) = browser_bridge::shape_to_workflow_event(
                shape,
                (
                    "00000000-0000-7000-8000-000000000000",
                    "00000000-0000-7000-8000-000000000001",
                    "00000000-0000-7000-8000-000000000002",
                ),
                browser_bridge::now_unix_ms(),
                &store::iso_from_unix_ms(browser_bridge::now_unix_ms()),
                &event_id,
            ) else {
                return serde_json::json!({"ok": false, "error": "malformed shape"});
            };
            // Same gate + encrypted pipeline as every other event.
            let settings = load_gate_settings(app);
            match gate_event(&settings, &event) {
                Ok(None) => {
                    let app2 = app.clone();
                    let result = tauri::async_runtime::block_on(async move {
                        let state = app2.state::<StoreState>();
                        let guard = store_guard(&app2, &state).await?;
                        guard
                            .as_ref()
                            .expect("initialized")
                            .insert_event(&event, store::EVENT_RETENTION_DAYS_DEFAULT)
                            .await
                            .map_err(|e| e.to_string())
                    });
                    match result {
                        Ok(_) => serde_json::json!({"ok": true}),
                        Err(e) => serde_json::json!({"ok": false, "error": e}),
                    }
                }
                Ok(Some(reason)) => serde_json::json!({"ok": true, "dropped": reason}),
                Err(e) => serde_json::json!({"ok": false, "error": e}),
            }
        }
        _ => serde_json::json!({"ok": false, "error": "unknown request"}),
    }
}

/// Deterministic UUID-shaped id from a hash (browser events arrive without ids).
fn uuid_v4_like(hash_hex: &str) -> String {
    let h = format!("{hash_hex:0<32}");
    format!(
        "{}-{}-7{}-8{}-{}",
        &h[0..8],
        &h[8..12],
        &h[13..16],
        &h[17..20],
        &h[20..32]
    )
}

fn start_bridge_listener<R: Runtime>(app: AppHandle<R>) {
    std::thread::spawn(move || {
        let Ok(path) = socket_path(&app) else { return };
        let _ = fs::remove_file(&path);
        let Ok(listener) = std::os::unix::net::UnixListener::bind(&path) else {
            eprintln!("bridge: cannot bind socket");
            return;
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
        }
        for stream in listener.incoming().flatten() {
            use std::io::{BufRead, BufReader, Write};
            let mut reader = BufReader::new(&stream);
            let mut line = String::new();
            if reader.read_line(&mut line).is_err() {
                continue;
            }
            let reply = match serde_json::from_str::<serde_json::Value>(&line) {
                Ok(request) => handle_bridge_request(&app, &request),
                Err(e) => serde_json::json!({"ok": false, "error": format!("bad json: {e}")}),
            };
            let mut writer = &stream;
            let _ = writer.write_all(format!("{reply}\n").as_bytes());
        }
    });
}

/// Explicit “Delete this device's data”: removes the database and Keychain key.
#[tauri::command]
async fn device_data_wipe<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    state: tauri::State<'_, StoreState>,
    confirm: String,
) -> Result<(), String> {
    require_panel(&window)?;
    if confirm != "delete-device-data" {
        return Err("confirmation phrase mismatch".into());
    }
    let mut guard = state.0.lock().await;
    if let Some(store) = guard.take() {
        store.close().await;
    }
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = fs::remove_file(dir.join("maman-local.sqlite"));
    }
    store::delete_keychain_key(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
    Ok(())
}

// ---------- device enrollment + sync (all HTTP originates here in Rust) ----------

/// The user's authenticated identity, handed from the webview after sign-in.
/// In dev/local mode it is dev identity headers; in production a WorkOS bearer.
#[derive(Debug, Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase")]
enum UserAuth {
    Dev {
        organization_id: String,
        user_id: String,
        #[serde(default = "default_role")]
        role: String,
    },
    Workos {
        bearer: String,
    },
}

fn default_role() -> String {
    "member".to_string()
}

impl UserAuth {
    fn headers(&self) -> Vec<(String, String)> {
        match self {
            UserAuth::Dev { organization_id, user_id, role } => vec![
                ("x-dev-org-id".into(), organization_id.clone()),
                ("x-dev-user-id".into(), user_id.clone()),
                ("x-dev-role".into(), role.clone()),
            ],
            UserAuth::Workos { bearer } => {
                vec![("authorization".into(), format!("Bearer {bearer}"))]
            }
        }
    }
}

/// Enrolls this device: exchanges the user session for a scoped device token,
/// which is stored in the keychain (never returned to the webview). Only the
/// device id and expiry are surfaced.
#[tauri::command]
async fn device_enroll<R: Runtime>(
    window: Window<R>,
    auth: UserAuth,
    device_public_id: String,
    app_version: String,
    observer_version: String,
) -> Result<serde_json::Value, String> {
    require_panel(&window)?;
    let transport = sync::ReqwestTransport::new().map_err(|e| e.to_string())?;
    let client = sync::SyncClient::new(transport, api_base_url());
    let body = serde_json::json!({
        "device_public_id": device_public_id,
        "platform": "macos",
        "app_version": app_version,
        "observer_version": observer_version,
        "capabilities": ["macos_ax"],
    });
    let result = client.enroll(auth.headers(), body).await.map_err(|e| e.to_string())?;
    store::store_keychain_secret(KEYCHAIN_SERVICE, KEYCHAIN_DEVICE_TOKEN_ACCOUNT, &result.device_token)?;
    Ok(serde_json::json!({
        "device_id": result.device_id,
        "device_token_expires_at": result.device_token_expires_at,
        "enrolled": true,
    }))
}

/// Drains the encrypted outbox and uploads redacted projections now.
#[tauri::command]
async fn sync_now<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    state: tauri::State<'_, StoreState>,
) -> Result<serde_json::Value, String> {
    require_panel(&window)?;
    let token = store::load_keychain_secret(KEYCHAIN_SERVICE, KEYCHAIN_DEVICE_TOKEN_ACCOUNT)
        .ok_or("device not enrolled")?;
    let guard = store_guard(&app, &state).await?;
    let store = guard.as_ref().ok_or("store unavailable")?;
    let transport = sync::ReqwestTransport::new().map_err(|e| e.to_string())?;
    let client = sync::SyncClient::new(transport, api_base_url());
    let outcome = sync::drain_and_push(store, &client, &token, 200)
        .await
        .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "uploaded": outcome.uploaded,
        "deduped": outcome.deduped,
        "remaining": outcome.remaining,
    }))
}

/// Whether this device is enrolled — true iff a device token exists in the
/// keychain. Exposes ONLY a boolean; the token itself never reaches the webview.
#[tauri::command]
fn device_enrolled<R: Runtime>(window: Window<R>) -> Result<bool, String> {
    require_panel(&window)?;
    Ok(store::load_keychain_secret(KEYCHAIN_SERVICE, KEYCHAIN_DEVICE_TOKEN_ACCOUNT).is_some())
}

/// Removes the device token from the keychain (local-only mode again). The
/// server session is unaffected here; the user can re-enroll to get a new token.
#[tauri::command]
fn device_unenroll<R: Runtime>(window: Window<R>) -> Result<(), String> {
    require_panel(&window)?;
    store::delete_keychain_key(KEYCHAIN_SERVICE, KEYCHAIN_DEVICE_TOKEN_ACCOUNT);
    Ok(())
}

/// Loads the device token from the keychain, or errors if not enrolled.
fn require_device_token() -> Result<String, String> {
    store::load_keychain_secret(KEYCHAIN_SERVICE, KEYCHAIN_DEVICE_TOKEN_ACCOUNT)
        .ok_or_else(|| "device not enrolled".to_string())
}

/// Builds a sync client against the configured API base URL.
fn server_client() -> Result<sync::SyncClient<sync::ReqwestTransport>, String> {
    let transport = sync::ReqwestTransport::new().map_err(|e| e.to_string())?;
    Ok(sync::SyncClient::new(transport, api_base_url()))
}

/// Compiles an accepted PatternCandidate into an AgentSpec on the server.
#[tauri::command]
async fn server_compile_agent<R: Runtime>(
    window: Window<R>,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    require_panel(&window)?;
    let token = require_device_token()?;
    server_client()?.compile_agent(&token, body).await.map_err(|e| e.to_string())
}

/// Persists a compiled AgentSpec (agent + immutable version) on the server.
#[tauri::command]
async fn server_create_agent<R: Runtime>(
    window: Window<R>,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    require_panel(&window)?;
    let token = require_device_token()?;
    server_client()?.create_agent(&token, body).await.map_err(|e| e.to_string())
}

/// Starts a run (shadow/supervised) via the API→Temporal path.
#[tauri::command]
async fn server_start_run<R: Runtime>(
    window: Window<R>,
    agent_id: String,
    mode: String,
    idempotency_key: String,
) -> Result<serde_json::Value, String> {
    require_panel(&window)?;
    if mode != "shadow" && mode != "supervised" && mode != "active" {
        return Err("invalid run mode".into());
    }
    let token = require_device_token()?;
    let body = serde_json::json!({ "mode": mode, "trigger_idempotency_key": idempotency_key });
    server_client()?.start_run(&token, &agent_id, body).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn server_run_status<R: Runtime>(
    window: Window<R>,
    run_id: String,
) -> Result<serde_json::Value, String> {
    require_panel(&window)?;
    let token = require_device_token()?;
    server_client()?.run_status(&token, &run_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn server_pending_approval<R: Runtime>(
    window: Window<R>,
    run_id: String,
) -> Result<serde_json::Value, String> {
    require_panel(&window)?;
    let token = require_device_token()?;
    server_client()?.pending_approval(&token, &run_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn server_proposal<R: Runtime>(
    window: Window<R>,
    run_id: String,
) -> Result<serde_json::Value, String> {
    require_panel(&window)?;
    let token = require_device_token()?;
    server_client()?.proposal(&token, &run_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn server_receipt<R: Runtime>(
    window: Window<R>,
    run_id: String,
) -> Result<serde_json::Value, String> {
    require_panel(&window)?;
    let token = require_device_token()?;
    server_client()?.receipt(&token, &run_id).await.map_err(|e| e.to_string())
}

/// Approves a pending write. The approval is bound to step id + diff hash
/// server-side (the workflow re-checks the hash); this command only relays.
#[tauri::command]
async fn server_approve_run<R: Runtime>(
    window: Window<R>,
    run_id: String,
    step_id: String,
    diff_hash: String,
) -> Result<serde_json::Value, String> {
    require_panel(&window)?;
    let token = require_device_token()?;
    let body = serde_json::json!({ "step_id": step_id, "diff_hash": diff_hash });
    server_client()?.approve_run(&token, &run_id, body).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn server_reject_run<R: Runtime>(
    window: Window<R>,
    run_id: String,
    step_id: String,
    reason: String,
) -> Result<serde_json::Value, String> {
    require_panel(&window)?;
    let token = require_device_token()?;
    let body = serde_json::json!({ "step_id": step_id, "reason": reason });
    server_client()?.reject_run(&token, &run_id, body).await.map_err(|e| e.to_string())
}

/// Resolves the seeded demo dev identity (org + owner user + role) from the API.
/// Runs in Rust because the webview may not reach the API directly (CSP).
async fn resolve_demo_identity() -> Result<(String, String, String), String> {
    let client = server_client()?;
    let org = client.resolve_org(DEMO_ORG_WORKOS_ID).await.map_err(|e| match e {
        sync::SyncError::Server(s) => {
            format!("Could not resolve the demo org ({s}). Is the API running and seeded?")
        }
        other => other.to_string(),
    })?;
    let organization_id = org
        .get("organization_id")
        .and_then(|v| v.as_str())
        .ok_or("resolve-org returned no organization_id")?
        .to_string();
    let user = client.resolve_user(DEMO_USER_WORKOS_ID).await.map_err(|e| match e {
        sync::SyncError::Server(s) => {
            format!("Could not resolve the demo user ({s}). Is the API seeded?")
        }
        other => other.to_string(),
    })?;
    let user_id = user
        .get("user_id")
        .and_then(|v| v.as_str())
        .ok_or("resolve-user returned no user_id")?
        .to_string();
    let role = user.get("role").and_then(|v| v.as_str()).unwrap_or("member").to_string();
    Ok((organization_id, user_id, role))
}

/// Resolves the dev identity for local enrollment. Returns non-secret ids only
/// (org/user/role); the webview passes these straight back to `device_enroll`.
#[tauri::command]
async fn resolve_dev_identity<R: Runtime>(window: Window<R>) -> Result<serde_json::Value, String> {
    require_panel(&window)?;
    let (organization_id, user_id, role) = resolve_demo_identity().await?;
    Ok(serde_json::json!({
        "organization_id": organization_id,
        "user_id": user_id,
        "role": role,
    }))
}

/// Opens an http(s) URL in the user's DEFAULT system browser (Chrome, Safari,
/// …) via `open`. Rejects any non-http(s) scheme so this can't be turned into a
/// local-file / custom-scheme opener.
fn open_url_in_browser(url: &str) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("refusing to open a non-http(s) URL".into());
    }
    std::process::Command::new("open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("could not open the browser: {e}"))
}

/// Requests an OAuth authorization URL for a connector and OPENS it in the
/// system browser (the OAuth flow — and the redirect back to the API — happens
/// entirely there, never in this webview). Resolves the dev principal and calls
/// the API from Rust; no token or client-origin HTTP touches the app.
#[tauri::command]
async fn connector_authorize<R: Runtime>(
    window: Window<R>,
    provider: String,
) -> Result<serde_json::Value, String> {
    require_panel(&window)?;
    let (organization_id, user_id, role) = resolve_demo_identity().await?;
    let headers = vec![
        ("x-dev-org-id".to_string(), organization_id),
        ("x-dev-user-id".to_string(), user_id),
        ("x-dev-role".to_string(), role),
    ];
    let body = server_client()?
        .connector_authorize(headers, &provider)
        .await
        .map_err(|e| e.to_string())?;
    let url = body
        .get("authorization_url")
        .and_then(|v| v.as_str())
        .ok_or("connector authorize returned no authorization_url")?;
    open_url_in_browser(url)?;
    Ok(serde_json::json!({ "authorization_url": url, "opened": true }))
}

/// Background sync loop: periodically drains the outbox when a device is
/// enrolled. Best-effort — failures defer the batch and are retried next tick.
fn start_sync_loop<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(SYNC_INTERVAL_SECS)).await;
            let Some(token) =
                store::load_keychain_secret(KEYCHAIN_SERVICE, KEYCHAIN_DEVICE_TOKEN_ACCOUNT)
            else {
                continue;
            };
            let state = app.state::<StoreState>();
            let Ok(guard) = store_guard(&app, &state).await else {
                continue;
            };
            let Some(store) = guard.as_ref() else { continue };
            let Ok(transport) = sync::ReqwestTransport::new() else { continue };
            let client = sync::SyncClient::new(transport, api_base_url());
            let _ = sync::drain_and_push(store, &client, &token, 200).await;
        }
    });
}

// ---------- observer sidecar supervision ----------

use observer::{ObserverGate, ObserverStatus};

/// Live observer status, surfaced to the pet UI (honest, never a silent degrade).
pub struct ObserverState(pub std::sync::Mutex<ObserverStatus>);

fn set_observer_status<R: Runtime>(app: &AppHandle<R>, status: ObserverStatus) {
    if let Some(state) = app.try_state::<ObserverState>() {
        if let Ok(mut guard) = state.0.lock() {
            *guard = status;
        }
    }
    let label = match status {
        ObserverStatus::Disabled => "disabled",
        ObserverStatus::Starting => "starting",
        ObserverStatus::Observing => "observing",
        ObserverStatus::PermissionRequired => "permission_required",
        ObserverStatus::Failed => "failed",
    };
    let _ = app.emit("observer:status", label);
}

#[tauri::command]
fn observer_status<R: Runtime>(app: AppHandle<R>) -> String {
    let status = app
        .try_state::<ObserverState>()
        .and_then(|s| s.0.lock().ok().map(|g| *g))
        .unwrap_or(ObserverStatus::Disabled);
    match status {
        ObserverStatus::Disabled => "disabled",
        ObserverStatus::Starting => "starting",
        ObserverStatus::Observing => "observing",
        ObserverStatus::PermissionRequired => "permission_required",
        ObserverStatus::Failed => "failed",
    }
    .to_string()
}

/// Opens the macOS Accessibility settings pane so the user can grant permission.
#[tauri::command]
fn open_accessibility_settings() -> Result<(), String> {
    std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Reads the observer gate (consent complete AND not paused) from settings.
fn load_observer_gate<R: Runtime>(app: &AppHandle<R>) -> ObserverGate {
    let json = config_path(app, SETTINGS_FILE)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok());
    let consent = json
        .as_ref()
        .map(|j| {
            j.get("onboarding_complete").and_then(|v| v.as_bool()).unwrap_or(false)
                && j.get("comprehension_confirmed").and_then(|v| v.as_bool()).unwrap_or(false)
        })
        .unwrap_or(false);
    let paused = json
        .as_ref()
        .and_then(|j| j.get("observation_paused").and_then(|v| v.as_bool()))
        .unwrap_or(true);
    ObserverGate { consent_complete: consent, observation_paused: paused }
}

/// Resolves the observer sidecar binary: alongside the app executable in a
/// bundle, or the local Swift release build during development.
fn resolve_observer_binary<R: Runtime>(_app: &AppHandle<R>) -> Option<PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let bundled = dir.join("maman-observer");
            if bundled.exists() {
                return Some(bundled);
            }
        }
    }
    // Dev fallback: the Swift release build in the repo.
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../native/macos-observer/.build/release/maman-observer");
    if dev.exists() {
        return Some(dev);
    }
    None
}

/// Persists one observer-emitted event through the central ingest gate.
/// Re-applying `gate_event` here is the authoritative, LIVE check: the Swift
/// observer's allowlist/private/paused config is pushed once at spawn and can
/// go stale, so this guarantees a freshly paused / newly private / hard-denied
/// context is dropped even before the sidecar restarts (spec §10 central gate).
async fn ingest_observer_value<R: Runtime>(app: &AppHandle<R>, event: &serde_json::Value) {
    let settings = load_gate_settings(app);
    let mut deltas = IngestResult {
        stored: 0,
        dropped_paused: 0,
        dropped_denied: 0,
        dropped_not_allowlisted: 0,
        boundary_events: 0,
        rejected_forbidden: 0,
    };
    match gate_event(&settings, event) {
        Ok(None) => {
            let state = app.state::<StoreState>();
            let mut guard = match store_guard(app, &state).await {
                Ok(g) => g,
                Err(_) => return,
            };
            if let Some(store) = guard.as_mut() {
                match store.insert_event(event, store::EVENT_RETENTION_DAYS_DEFAULT).await {
                    Ok(_) => deltas.stored += 1,
                    Err(store::StoreError::ForbiddenField(_)) => deltas.rejected_forbidden += 1,
                    Err(_) => {}
                }
            }
        }
        Ok(Some(reason)) => match reason.as_str() {
            "observation_paused" => deltas.dropped_paused += 1,
            "not_allowlisted" => deltas.dropped_not_allowlisted += 1,
            _ => deltas.dropped_denied += 1,
        },
        Err(_) => return,
    }
    record_observation_stats(app, &deltas);
}

/// Supervises the observer sidecar: spawns only when the gate allows, streams
/// its JSONL over stdio into the ingest gate, and applies the restart policy.
/// A quiet loop re-checks the gate so pause/consent changes start/stop it.
fn start_observer_supervisor<R: Runtime>(app: AppHandle<R>) {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::process::Command as TokioCommand;

    tauri::async_runtime::spawn(async move {
        let mut policy = observer::RestartPolicy::new();
        loop {
            let gate = load_observer_gate(&app);
            if !gate.should_observe() {
                set_observer_status(&app, ObserverStatus::Disabled);
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                continue;
            }
            let Some(bin) = resolve_observer_binary(&app) else {
                set_observer_status(&app, ObserverStatus::Failed);
                tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                continue;
            };

            set_observer_status(&app, ObserverStatus::Starting);
            let spawned = TokioCommand::new(&bin)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null())
                .spawn();
            let mut child = match spawned {
                Ok(c) => c,
                Err(_) => {
                    if policy.on_crash(std::time::Instant::now()) == observer::RestartDecision::GiveUp
                    {
                        set_observer_status(&app, ObserverStatus::Failed);
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    continue;
                }
            };

            // Configure the observer with the current settings, then resume.
            // Keep the control pipe open for the child's lifetime WITHOUT leaking
            // it: this binding drops (closing the pipe) at the end of the
            // iteration, after the child has exited — no per-respawn FD leak.
            let mut control_stdin = child.stdin.take();
            let mut last_config = observer_configure_line(&load_gate_settings(&app));
            if let Some(stdin) = control_stdin.as_mut() {
                let _ = stdin.write_all(format!("{last_config}\n").as_bytes()).await;
                let _ = stdin.write_all(b"{\"type\":\"resume\"}\n").await;
                let _ = stdin.flush().await;
            }

            set_observer_status(&app, ObserverStatus::Observing);
            let started = std::time::Instant::now();
            // Distinguishes a deliberate stop (pause / consent revoked) from a
            // crash so an intentional stop never burns the restart budget.
            let mut intentional_stop = false;
            if let Some(stdout) = child.stdout.take() {
                let mut lines = BufReader::new(stdout).lines();
                loop {
                    // Stop promptly on pause / consent revoke — the 2s read
                    // timeout below guarantees this is re-checked even when the
                    // observer is idle (no events to unblock the read).
                    if !load_observer_gate(&app).should_observe() {
                        let _ = child.start_kill();
                        intentional_stop = true;
                        break;
                    }
                    // Live reconfigure: push a fresh allowlist / observe-all /
                    // private config within ~2s of a settings change — no restart.
                    let current_config = observer_configure_line(&load_gate_settings(&app));
                    if current_config != last_config {
                        last_config = current_config.clone();
                        if let Some(stdin) = control_stdin.as_mut() {
                            let _ = stdin.write_all(format!("{current_config}\n").as_bytes()).await;
                            let _ = stdin.flush().await;
                        }
                    }
                    match tokio::time::timeout(
                        std::time::Duration::from_secs(2),
                        lines.next_line(),
                    )
                    .await
                    {
                        Ok(Ok(Some(line))) => match observer::parse_observer_line(&line) {
                            observer::ObserverLine::Event(ev) => ingest_observer_value(&app, &ev).await,
                            observer::ObserverLine::Boundary { .. } => {
                                set_observer_status(&app, ObserverStatus::Observing);
                            }
                            observer::ObserverLine::Error { code, fatal } => {
                                set_observer_status(&app, observer::status_for_error(&code, fatal));
                            }
                            observer::ObserverLine::Heartbeat { .. }
                            | observer::ObserverLine::Hello { .. }
                            | observer::ObserverLine::Ignored => {}
                        },
                        Ok(_) => break, // stdout closed → child exiting
                        Err(_) => {}    // 2s idle tick: re-check gate + config
                    }
                }
            }

            let _ = child.wait().await;
            drop(control_stdin); // close the control pipe now the child is gone

            // A deliberate pause/consent stop is NOT a crash: don't penalize the
            // restart budget — loop back and let the gate check idle or resume.
            if intentional_stop {
                set_observer_status(&app, ObserverStatus::Disabled);
                continue;
            }

            // A long healthy run clears the restart history.
            if started.elapsed() > std::time::Duration::from_secs(60) {
                policy.on_stable();
            }
            if policy.on_crash(std::time::Instant::now()) == observer::RestartDecision::GiveUp {
                // Surface Failed but do NOT exit the supervisor: after a cool-off
                // the crash window ages out and observation can recover on its own
                // (or when the user re-enables it) — a rough patch never becomes
                // a permanent dead state.
                set_observer_status(&app, ObserverStatus::Failed);
                tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                continue;
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
    });
}

// ---------- entry ----------

pub fn run() {
    let last_move_ms: Arc<AtomicI64> = Arc::new(AtomicI64::new(0));

    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(StoreState(Mutex::new(None)))
        .manage(ObserverState(std::sync::Mutex::new(ObserverStatus::Disabled)))
        .invoke_handler(tauri::generate_handler![
            settings_load,
            settings_save,
            toggle_panel,
            hide_panel,
            quit_app,
            events_ingest,
            events_timeline,
            events_pattern_features,
            suggestions_load,
            suggestions_save,
            agents_load,
            agents_save,
            browser_relay_paired,
            events_delete,
            events_delete_all,
            events_delete_app,
            events_set_excluded,
            traces_save,
            traces_for_pattern,
            patterns_upsert,
            pattern_verification_save,
            verification_report,
            suggestion_history_log,
            sync_preview,
            hard_denied_list,
            observation_stats,
            device_data_wipe,
            pairing_begin,
            device_enroll,
            sync_now,
            device_enrolled,
            device_unenroll,
            server_compile_agent,
            server_create_agent,
            server_start_run,
            server_run_status,
            server_pending_approval,
            server_proposal,
            server_receipt,
            server_approve_run,
            server_reject_run,
            resolve_dev_identity,
            connector_authorize,
            observer_status,
            packs_status,
            open_accessibility_settings
        ])
        .setup(|app| {
            make_windows_visible_on_all_spaces(&app.handle().clone());
            restore_pet_position(&app.handle().clone());
            start_bridge_listener(app.handle().clone());
            start_sync_loop(app.handle().clone());
            start_observer_supervisor(app.handle().clone());

            // Global shortcut: Control+Option+P toggles the panel.
            {
                use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};
                let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyP);
                let handle = app.handle().clone();
                app.handle().global_shortcut().on_shortcut(shortcut, move |_app, _sc, event| {
                    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        toggle_panel_impl(&handle);
                    }
                })?;
            }
            Ok(())
        })
        .on_window_event({
            let last_move_ms = last_move_ms.clone();
            move |window, event| {
                // Closing the panel must hide it, not destroy it — otherwise the
                // window is gone and clicking the pet (or pressing the shortcut)
                // does nothing at all until the app is restarted.
                if hides_on_close(window.label()) {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                    return;
                }
                if window.label() != "pet" {
                    return;
                }
                if let tauri::WindowEvent::Moved(_) = event {
                    let now = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or(0);
                    last_move_ms.store(now, Ordering::Relaxed);
                    let app = window.app_handle().clone();
                    let last = last_move_ms.clone();
                    // Snap + persist once movement settles (drag finished).
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(450));
                        let now2 = SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .map(|d| d.as_millis() as i64)
                            .unwrap_or(0);
                        if now2 - last.load(Ordering::Relaxed) >= 440 {
                            persist_and_snap_pet(&app);
                        }
                    });
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Maman");
}

#[cfg(test)]
mod gate_tests {
    use super::{gate_event, GateSettings};
    use serde_json::json;

    fn settings() -> GateSettings {
        GateSettings {
            observation_paused: false,
            private_apps: vec!["figma".into()],
            allowlist_domains: vec!["salesforce.com".into(), "docs.google.com".into()],
            allowlist_bundles: vec!["com.google.Chrome".into()],
            observe_all_apps: false,
        }
    }

    fn event(display: &str, domain: Option<&str>, source: &str) -> serde_json::Value {
        json!({
            "source": source,
            "app": { "display_name": display, "domain": domain },
            "event_type": "record_opened"
        })
    }

    #[test]
    fn paused_observation_drops_everything() {
        let mut s = settings();
        s.observation_paused = true;
        let verdict = gate_event(&s, &event("Salesforce", Some("salesforce.com"), "chrome")).unwrap();
        assert_eq!(verdict, Some("observation_paused".into()));
    }

    #[test]
    fn hard_denied_contexts_become_boundaries() {
        let verdict = gate_event(&settings(), &event("1Password 8", None, "macos_ax")).unwrap();
        assert_eq!(verdict, Some("hard_denied".into()));
        let verdict = gate_event(&settings(), &event("Chrome", Some("www.chase.com"), "chrome")).unwrap();
        assert_eq!(verdict, Some("hard_denied".into()));
    }

    #[test]
    fn user_private_apps_become_boundaries() {
        let verdict = gate_event(&settings(), &event("Figma", None, "macos_ax")).unwrap();
        assert_eq!(verdict, Some("user_private".into()));
    }

    #[test]
    fn non_allowlisted_browser_domains_are_dropped() {
        let verdict =
            gate_event(&settings(), &event("Chrome", Some("random-site.example"), "chrome")).unwrap();
        assert_eq!(verdict, Some("not_allowlisted".into()));
    }

    #[test]
    fn lookalike_domains_do_not_match_the_allowlist() {
        // allowlist has "salesforce.com" — none of these are it or a subdomain.
        for host in [
            "notsalesforce.com",
            "evil-salesforce.com.attacker.com",
            "force.com",
            "salesforce.com.attacker.com",
        ] {
            assert_eq!(
                gate_event(&settings(), &event("Chrome", Some(host), "chrome")).unwrap(),
                Some("not_allowlisted".into()),
                "lookalike {host} must be dropped"
            );
        }
    }

    #[test]
    fn allowlisted_events_pass() {
        assert_eq!(
            gate_event(&settings(), &event("Salesforce", Some("acme.my.salesforce.com"), "chrome"))
                .unwrap(),
            None
        );
        assert_eq!(
            gate_event(&settings(), &event("Google Sheets", Some("docs.google.com"), "chrome"))
                .unwrap(),
            None
        );
    }
}

#[cfg(test)]
mod open_url_tests {
    use super::open_url_in_browser;

    #[test]
    fn rejects_non_http_schemes() {
        // Guard: this opener must never be usable for file:// or custom schemes.
        assert!(open_url_in_browser("file:///etc/passwd").is_err());
        assert!(open_url_in_browser("x-apple.systempreferences:foo").is_err());
        assert!(open_url_in_browser("javascript:alert(1)").is_err());
        assert!(open_url_in_browser("data:text/html,hi").is_err());
    }
    // The http(s) success path spawns `open`, so it is exercised by the manual
    // connector verification, not here (a unit test must not launch a browser).
}

#[cfg(test)]
mod csp_tests {
    //! The webview must NEVER reach the API directly — all device→server HTTP
    //! originates in Rust. These tests fail if someone "fixes" a blocked request
    //! by loosening the Content-Security-Policy instead of routing it through a
    //! Tauri command (see M18.1).

    fn tauri_conf() -> String {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json");
        std::fs::read_to_string(path).expect("tauri.conf.json is readable")
    }

    #[test]
    fn csp_does_not_allow_the_api_origin() {
        let conf = tauri_conf();
        assert!(
            !conf.contains("localhost:4000"),
            "CSP/tauri.conf must not whitelist the API origin — route HTTP through Rust instead"
        );
    }

    #[test]
    fn csp_connect_src_stays_locked_to_self_and_ipc() {
        let conf = tauri_conf();
        assert!(
            conf.contains("connect-src 'self' ipc: http://ipc.localhost"),
            "connect-src must stay locked to self + Tauri IPC"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::snap_to_edges;

    const BOUNDS: (i32, i32, u32, u32) = (0, 0, 1920, 1080);
    const SIZE: (u32, u32) = (112, 128);

    #[test]
    fn snaps_to_left_edge_within_threshold() {
        assert_eq!(snap_to_edges((10, 500), SIZE, BOUNDS), (16, 500));
    }

    #[test]
    fn snaps_to_right_edge_within_threshold() {
        let x = 1920 - 112 - 5;
        assert_eq!(snap_to_edges((x, 500), SIZE, BOUNDS), (1920 - 112 - 16, 500));
    }

    #[test]
    fn snaps_to_bottom_edge() {
        let y = 1080 - 128 - 30;
        assert_eq!(snap_to_edges((800, y), SIZE, BOUNDS), (800, 1080 - 128 - 16));
    }

    #[test]
    fn does_not_snap_when_far_from_edges() {
        assert_eq!(snap_to_edges((800, 500), SIZE, BOUNDS), (800, 500));
    }

    #[test]
    fn clamps_fully_offscreen_positions_back_onscreen() {
        let (x, y) = snap_to_edges((-500, 5000), SIZE, BOUNDS);
        assert!(x >= 0 && y + 128 <= 1080);
    }

    #[test]
    fn respects_monitor_origin_offsets() {
        let bounds = (1920, 0, 1920, 1080); // second display to the right
        assert_eq!(snap_to_edges((1925, 500), SIZE, bounds), (1936, 500));
    }
}

#[cfg(test)]
mod panel_close_tests {
    //! The panel is a hideable surface. If its close button destroys the window,
    //! `get_webview_window("panel")` returns None and every later open path
    //! (pet click, global shortcut) silently no-ops until the app restarts —
    //! the window looks fine, the pet just stops responding.
    use super::hides_on_close;

    #[test]
    fn the_panel_hides_on_close_but_the_pet_does_not() {
        assert!(hides_on_close("panel"));
        assert!(!hides_on_close("pet"));
        assert!(!hides_on_close("other"));
    }

    #[test]
    fn the_close_handler_prevents_destruction_and_hides() {
        // The behavior lives in a Tauri window-event closure that cannot be
        // constructed in a unit test, so assert the wiring the way csp_tests
        // asserts the CSP: someone removing it has to remove this too.
        let src = include_str!("lib.rs");
        let handler = src
            .split("if hides_on_close(window.label())")
            .nth(1)
            .expect("panel close branch missing from on_window_event");
        let branch = &handler[..handler.find("if window.label() != \"pet\"").unwrap_or(400)];
        assert!(
            branch.contains("CloseRequested"),
            "panel branch must handle CloseRequested"
        );
        assert!(
            branch.contains("prevent_close"),
            "panel close must be prevented, never allowed to destroy the window"
        );
        assert!(branch.contains(".hide()"), "panel close must hide the window");
    }
}
