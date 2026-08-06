//! Maman desktop core.
//!
//! Trust boundary: the webview is untrusted relative to this Rust core.
//! Commands validate their inputs, and window-sensitive commands check the
//! calling window's label (the pet window may never reach privileged surfaces).

pub mod browser_bridge;
pub mod browser_relay;
pub mod domain;
pub mod observer;
pub mod redaction;
pub mod store;
pub mod sync;
pub mod vision;

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

/// Managed state: the single-flight keychain acquisition (see GuardedKeyAcquire).
pub struct KeyAcquireState(pub store::GuardedKeyAcquire);

/// Honest local-store health, ObserverStatus-style: a keychain-blocked store
/// must render as needing attention, never hang silently.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoreStatus {
    /// Opened (or not yet needed) — store commands work normally.
    Ok,
    /// The keychain never released (or refused) the store key: the user must
    /// approve access. Never "fixed" by deleting/recreating the key — that
    /// would orphan the encrypted store.
    KeychainAccessRequired,
    /// Open failed for a non-keychain reason (disk, migration).
    Failed,
}

pub struct StoreHealth(pub std::sync::Mutex<StoreStatus>);

fn store_status_label(status: StoreStatus) -> &'static str {
    match status {
        StoreStatus::Ok => "ok",
        StoreStatus::KeychainAccessRequired => "keychain_access_required",
        StoreStatus::Failed => "failed",
    }
}

/// Maps a store-open error to the status the UI should show. Any key-provider
/// failure — timeout OR error — means the user must (re-)grant keychain access.
fn store_status_for_error(e: &store::StoreError) -> StoreStatus {
    match e {
        store::StoreError::KeyTimeout | store::StoreError::Key(_) => {
            StoreStatus::KeychainAccessRequired
        }
        _ => StoreStatus::Failed,
    }
}

fn set_store_status<R: Runtime>(app: &AppHandle<R>, status: StoreStatus) {
    let changed = app
        .try_state::<StoreHealth>()
        .and_then(|state| {
            state.0.lock().ok().map(|mut guard| {
                let changed = *guard != status;
                *guard = status;
                changed
            })
        })
        .unwrap_or(true);
    if changed {
        let _ = app.emit("store:status", store_status_label(status));
    }
}

/// Current local-store health for the panel and status bar (poll + event).
#[tauri::command]
fn store_status<R: Runtime>(app: AppHandle<R>) -> String {
    app.try_state::<StoreHealth>()
        .and_then(|s| s.0.lock().ok().map(|g| store_status_label(*g)))
        .unwrap_or("ok")
        .to_string()
}

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
        // The keychain call runs on its own thread with a timeout: macOS
        // securityd can block it forever (observed live: the "Always Allow"
        // ACL dialog never rendered for the accessory-style app after a
        // rebuild+re-sign), and blocking here would freeze every store command
        // while holding the store mutex.
        let provider = Arc::new(KeychainKeyProvider {
            service: KEYCHAIN_SERVICE.to_string(),
            account: KEYCHAIN_ACCOUNT.to_string(),
        });
        let acquire = app.state::<KeyAcquireState>();
        let key = match acquire
            .0
            .acquire(provider, store::KEY_FIRST_WAIT, store::KEY_RETRY_WAIT)
            .await
        {
            Ok(key) => key,
            Err(e) => {
                let status = store_status_for_error(&e);
                set_store_status(app, status);
                return Err(match status {
                    StoreStatus::KeychainAccessRequired => format!(
                        "keychain_access_required: {e} — relaunch Maman and click \"Always Allow\""
                    ),
                    _ => format!("store key unavailable: {e}"),
                });
            }
        };
        // Domain packs for the L1 classifier. Resolved from the bundled resource
        // dir, falling back to the repo checkout in dev. Missing packs are fine:
        // nothing gets classified and observation is unaffected.
        let packs = domain::load_packs(&domain_packs_dir(app));
        let store =
            LocalStore::open_with_key(&dir.join("maman-local.sqlite"), key, "local-user", packs)
                .await
                .map_err(|e| {
                    set_store_status(app, StoreStatus::Failed);
                    format!("store open failed: {e}")
                })?;
        set_store_status(app, StoreStatus::Ok);
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
    /// Whether Teach Mode SESSIONS may be started at all. Defaults to false on
    /// every failure path below, because a missing or unparseable settings file
    /// must never be the reason pixels start leaving the device.
    teach_mode_enabled: bool,
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
        teach_mode_enabled: json
            .get("teach_mode_enabled")
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
fn observer_configure_line(
    settings: &GateSettings,
    label_patterns: &[String],
    self_bundle_id: &str,
) -> String {
    let bundles: Vec<String> = if settings.observe_all_apps {
        vec!["*".to_string()]
    } else {
        settings.allowlist_bundles.clone()
    };
    // MAMAN MUST NEVER OBSERVE ITSELF. With observe_all_apps ("*") it otherwise
    // watches its own panel, pet, and status bar: that pollutes the event store
    // with Maman's own UI as if it were the user's work, and — once the subtitle
    // bar started docking to the monitored window — created a feedback loop where
    // moving the bar produced a window-moved notification that moved it again,
    // walking it up the screen 6pt at a time. Excluded via private_apps, the
    // existing "never observe" channel, so the observer needs no special case.
    let mut private_apps = settings.private_apps.clone();
    if !self_bundle_id.is_empty() && !private_apps.iter().any(|a| a == self_bundle_id) {
        private_apps.push(self_bundle_id.to_string());
    }
    serde_json::json!({
        "type": "configure",
        "allowlist_bundles": bundles,
        "allowlist_domains": settings.allowlist_domains,
        "private_apps": private_apps,
        // Pack label_patterns, pushed as plain strings: the observer matches
        // them against pre-hash label text and emits ONLY the pattern strings
        // that fired. No YAML and no new dependency enters the observer.
        "label_patterns": label_patterns,
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
    for label in ["pet", "panel", "statusbar"] {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.set_visible_on_all_workspaces(true);
        }
    }
}

/// Places the status bar bottom-center of the primary display and makes it
/// click-through: it is a read-only subtitle, never an interaction target.
/// Shown only when `statusbar_enabled` (default on).
///
/// POSITIONING USES THE WORK AREA, NOT THE FULL SCREEN. The Dock is drawn at a
/// higher window level than an ordinary always-on-top window, so a bar placed
/// against the physical bottom edge is COMPLETELY HIDDEN behind it — which is
/// exactly how this shipped and why the health surface appeared to be missing on
/// a machine with the Dock at the bottom and auto-hide off. The work area
/// excludes the Dock and the menu bar, so anchoring to it puts the bar just
/// above the Dock wherever the user keeps it.
fn setup_statusbar<R: Runtime>(app: &AppHandle<R>) {
    let Some(bar) = app.get_webview_window("statusbar") else { return };
    // Click-through and draggable are mutually exclusive: a window that ignores
    // cursor events never receives the mouse, so it cannot be grabbed. The
    // setting picks which one the user wants; dragging is the default.
    let _ = bar.set_ignore_cursor_events(statusbar_click_through_setting(app));
    // Assert always-on-top explicitly rather than trusting the window config:
    // a health surface that ends up BEHIND an ordinary window reads as broken,
    // and this is the second time a bar the code believed was visible was not.
    let _ = bar.set_always_on_top(true);
    if let Some((x, y)) = saved_statusbar_position(app, &bar) {
        // A position the user chose by hand wins over any automatic placement —
        // but it is still CLAMPED onto the usable area. A drag can end at the
        // screen edge, and a position saved on a display that has since changed
        // resolution (or been unplugged) can point nowhere at all.
        let (cx, cy) = clamp_statusbar_position(&bar, (x, y));
        let _ = bar.set_position(PhysicalPosition::new(cx, cy));
    } else {
        position_statusbar(&bar);
    }
    let enabled = statusbar_enabled_setting(app);
    if enabled {
        let _ = bar.show();
    }
}

/// The key a manually-placed bar is stored under, per display, alongside the
/// pet's own positions. Prefixed so it can never collide with a monitor name.
fn statusbar_position_key<R: Runtime>(bar: &WebviewWindow<R>) -> String {
    statusbar_position_key_for(&monitor_key(bar))
}

/// The pure half, so the namespacing rule is testable without a display.
fn statusbar_position_key_for(monitor: &str) -> String {
    format!("statusbar@{monitor}")
}

/// A hand-placed position for this display, if the user moved the bar AND still
/// has following turned off. Both conditions matter: re-enabling "follow" must
/// resume docking even though the stored position is still on disk.
fn saved_statusbar_position<R: Runtime>(
    app: &AppHandle<R>,
    bar: &WebviewWindow<R>,
) -> Option<(i32, i32)> {
    if statusbar_follow_setting(app) {
        return None;
    }
    load_positions(app).0.get(&statusbar_position_key(bar)).copied()
}

/// Bottom-center of the primary monitor's WORK AREA, with a small gap.
///
/// Falls back to the full screen minus a Dock-sized margin if the platform
/// reports no usable work area: an approximate position keeps the surface
/// visible, whereas trusting a zero-sized work area would park it off-screen.
fn position_statusbar<R: Runtime>(bar: &tauri::WebviewWindow<R>) {
    let (Ok(Some(monitor)), Ok(size)) = (bar.primary_monitor(), bar.outer_size()) else {
        return;
    };
    let area = monitor.work_area();
    let (x, y) = statusbar_origin(
        (area.position.x, area.position.y),
        (area.size.width as i32, area.size.height as i32),
        (monitor.position().x, monitor.position().y),
        (monitor.size().width as i32, monitor.size().height as i32),
        (size.width as i32, size.height as i32),
    );
    let _ = bar.set_position(PhysicalPosition::new(x, y));
}

/// Gap between the bar and the bottom of the usable area (physical px).
const STATUSBAR_GAP: i32 = 8;
/// Dock-sized allowance used only when the work area is unusable.
const DOCK_FALLBACK: i32 = 96;

/// Pure placement arithmetic, extracted so it is testable without a display.
///
/// Anchors to the WORK AREA (excludes Dock and menu bar). Falls back to the full
/// screen minus a Dock-sized margin when the reported work area is too small to
/// be believable — an approximate position keeps the bar on screen, whereas
/// trusting a zero-sized work area would park it at the very bottom, behind the
/// Dock, which is the bug this function exists to prevent.
fn statusbar_origin(
    area_origin: (i32, i32),
    area_size: (i32, i32),
    screen_origin: (i32, i32),
    screen_size: (i32, i32),
    window: (i32, i32),
) -> (i32, i32) {
    let usable = if area_size.1 > window.1 {
        (area_origin.0, area_origin.1, area_size.0, area_size.1)
    } else {
        (
            screen_origin.0,
            screen_origin.1,
            screen_size.0,
            screen_size.1 - DOCK_FALLBACK,
        )
    };
    let x = usable.0 + (usable.2 - window.0) / 2;
    let y = usable.1 + usable.3 - window.1 - STATUSBAR_GAP;
    (x, y)
}

/// Docks the subtitle bar to the bottom of the window currently being monitored,
/// or returns it to the screen anchor when nothing is monitored.
///
/// This is the "subtitle at the bottom of the window you are working in"
/// behaviour. Only ONE window is monitored at a time — the observer attaches AX
/// to the frontmost allowlisted app — so one bar that follows focus is the whole
/// feature, not an approximation of it.
fn dock_statusbar<R: Runtime>(app: &AppHandle<R>, frame: Option<observer::WindowFrame>) {
    let Some(bar) = app.get_webview_window("statusbar") else { return };
    // A hidden bar (user turned it off) must not be moved or shown.
    if !bar.is_visible().unwrap_or(false) {
        return;
    }
    // The user dragged it somewhere: leave it alone. Automatic placement fighting
    // a deliberate choice is worse than no automatic placement at all.
    if !statusbar_should_auto_place(statusbar_follow_setting(app)) {
        return;
    }
    let Some(frame) = frame else {
        position_statusbar(&bar);
        return;
    };
    let Ok(size) = bar.outer_size() else { return };
    // Clamp against the display the WINDOW is on, not the primary one: on a
    // multi-display setup those differ, and clamping to the wrong work area would
    // yank the bar onto another screen. monitor_from_point wants physical pixels,
    // so scale the window's logical center by the primary scale factor first —
    // good enough to identify the display, and we re-read the real scale below.
    let Ok(Some(primary)) = bar.primary_monitor() else { return };
    let probe = primary.scale_factor();
    let center = (
        (frame.x + frame.width / 2.0) * probe,
        (frame.y + frame.height / 2.0) * probe,
    );
    let monitor = match bar.monitor_from_point(center.0, center.1) {
        Ok(Some(m)) => m,
        _ => primary,
    };
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    // AX reports logical points; compare in the same space as the bar's size.
    let bar_logical = (
        size.width as f64 / scale,
        size.height as f64 / scale,
    );
    let work_logical = (
        area.position.x as f64 / scale,
        area.position.y as f64 / scale,
        area.size.width as f64 / scale,
        area.size.height as f64 / scale,
    );
    let (x, y) = statusbar_origin_in_window(
        (frame.x, frame.y, frame.width, frame.height),
        bar_logical,
        work_logical,
    );
    let _ = bar.set_position(tauri::LogicalPosition::new(x, y));
}

/// Inset from the monitored window's bottom edge (logical points).
const DOCK_INSET: f64 = 6.0;

/// Pulls a hand-placed position back onto the usable area of its display.
///
/// Manual placement outranks automatic placement, but not the requirement to be
/// ON SCREEN: a drag that ends at an edge, or a position saved when the display
/// was larger, must not leave the bar somewhere the user cannot see or reach it.
fn clamp_statusbar_position<R: Runtime>(
    bar: &tauri::WebviewWindow<R>,
    saved: (i32, i32),
) -> (i32, i32) {
    let (Ok(Some(monitor)), Ok(size)) = (bar.primary_monitor(), bar.outer_size()) else {
        return saved;
    };
    let area = monitor.work_area();
    clamp_into_area(
        saved,
        (size.width as i32, size.height as i32),
        (
            area.position.x,
            area.position.y,
            area.size.width as i32,
            area.size.height as i32,
        ),
    )
}

/// Pure clamp: keeps the whole window inside the area when it fits, and pins it
/// to the origin when the area is smaller than the window (never an inverted
/// range).
fn clamp_into_area(
    pos: (i32, i32),
    window: (i32, i32),
    area: (i32, i32, i32, i32),
) -> (i32, i32) {
    let (ax, ay, aw, ah) = area;
    let max_x = ax + (aw - window.0).max(0);
    let max_y = ay + (ah - window.1).max(0);
    (pos.0.clamp(ax, max_x), pos.1.clamp(ay, max_y))
}

/// Whether automatic placement may move the bar.
///
/// Exists as a named function because it encodes a product rule rather than a
/// detail: a position the user chose by hand outranks every automatic placement,
/// including docking to the monitored window. Anything that moves the bar on its
/// own must ask this first.
fn statusbar_should_auto_place(follow_window: bool) -> bool {
    follow_window
}

/// Bottom-center of the monitored window, clamped to stay inside the work area.
///
/// The clamp is what keeps this honest: a window can be dragged half off-screen,
/// or be shorter than the bar itself, and in both cases the bar must remain
/// visible somewhere sensible rather than following the window into the void.
fn statusbar_origin_in_window(
    frame: (f64, f64, f64, f64),
    bar: (f64, f64),
    work: (f64, f64, f64, f64),
) -> (f64, f64) {
    let (fx, fy, fw, fh) = frame;
    let (bw, bh) = bar;
    let (wx, wy, ww, wh) = work;

    // Centered on the window, or left-aligned when the window is narrower.
    let desired_x = if fw >= bw { fx + (fw - bw) / 2.0 } else { fx };
    let desired_y = fy + fh - bh - DOCK_INSET;

    // Clamp into the usable area. max_* can fall below the origin on a tiny work
    // area, so clamp the low bound last to avoid an inverted range.
    let max_x = wx + ww - bw;
    let max_y = wy + wh - bh;
    let x = desired_x.min(max_x).max(wx);
    let y = desired_y.min(max_y).max(wy);
    (x, y)
}

/// Reads a boolean from settings.json with an explicit default. Fail-open to the
/// default: a corrupt settings file must not silently change bar behaviour.
fn settings_bool<R: Runtime>(app: &AppHandle<R>, key: &str, default: bool) -> bool {
    config_path(app, SETTINGS_FILE)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| v.get(key).and_then(|b| b.as_bool()))
        .unwrap_or(default)
}

/// Whether the bar docks to the monitored window (default on).
fn statusbar_follow_setting<R: Runtime>(app: &AppHandle<R>) -> bool {
    settings_bool(app, "statusbar_follow_window", true)
}

/// Whether clicks pass through the bar (default off, so it can be dragged).
fn statusbar_click_through_setting<R: Runtime>(app: &AppHandle<R>) -> bool {
    settings_bool(app, "statusbar_click_through", false)
}

/// Reads statusbar_enabled from settings.json (default true), fail-open to
/// visible: a corrupt settings file should not silently hide a health surface.
fn statusbar_enabled_setting<R: Runtime>(app: &AppHandle<R>) -> bool {
    config_path(app, SETTINGS_FILE)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| v.get("statusbar_enabled").and_then(|b| b.as_bool()))
        .unwrap_or(true)
}

/// Persists wherever the user just dragged the bar to, for THIS display.
///
/// Callable from the status bar itself (not panel-only): the bar is the window
/// being dragged, so it is the only surface that knows the drag finished. It can
/// write nothing but its own position — no settings, no store.
#[tauri::command]
fn statusbar_position_save<R: Runtime>(app: AppHandle<R>, window: Window<R>) -> Result<(), String> {
    if window.label() != "statusbar" {
        return Err("only the status bar may save its own position".into());
    }
    let Some(bar) = app.get_webview_window("statusbar") else {
        return Err("statusbar window unavailable".into());
    };
    let pos = bar.outer_position().map_err(|e| e.to_string())?;
    let mut positions = load_positions(&app);
    positions
        .0
        .insert(statusbar_position_key(&bar), (pos.x, pos.y));
    save_positions(&app, &positions);
    Ok(())
}

/// Forgets a hand-placed position so the bar resumes automatic placement.
/// Panel-only: this is a Settings action, not something the bar does to itself.
#[tauri::command]
fn statusbar_position_reset<R: Runtime>(app: AppHandle<R>, window: Window<R>) -> Result<(), String> {
    require_panel(&window)?;
    let Some(bar) = app.get_webview_window("statusbar") else {
        return Err("statusbar window unavailable".into());
    };
    let mut positions = load_positions(&app);
    positions.0.remove(&statusbar_position_key(&bar));
    save_positions(&app, &positions);
    position_statusbar(&bar);
    Ok(())
}

/// Applies the click-through setting to the live window, so the toggle takes
/// effect immediately instead of at the next launch.
#[tauri::command]
fn statusbar_apply_click_through<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    click_through: bool,
) -> Result<(), String> {
    require_panel(&window)?;
    let Some(bar) = app.get_webview_window("statusbar") else {
        return Err("statusbar window unavailable".into());
    };
    bar.set_ignore_cursor_events(click_through).map_err(|e| e.to_string())
}

/// Panel-only toggle for the status bar window.
#[tauri::command]
fn statusbar_set_visible<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    visible: bool,
) -> Result<(), String> {
    require_panel(&window)?;
    let Some(bar) = app.get_webview_window("statusbar") else {
        return Err("statusbar window unavailable".into());
    };
    if visible {
        // Re-place before showing: the Dock or display arrangement may have
        // changed since launch, and a bar behind the Dock reads as "broken".
        position_statusbar(&bar);
        bar.show().map_err(|e| e.to_string())
    } else {
        bar.hide().map_err(|e| e.to_string())
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

/// Dates read from labels inside the observer, with the pack classification of
/// the event they came from — the signal Layer 5 date-driven triggers (renewal
/// `term_end`) schedule against. Panel-only and explicitly local: no sync
/// projection reads this.
#[tauri::command]
async fn watched_dates<R: Runtime>(
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
        .watched_dates(limit.clamp(1, 5_000))
        .await
        .map_err(|e| e.to_string())
}

/// Appends a Layer 5 surfacing outcome (decision + context features) to the
/// local `suggestion_outcomes` ledger. The store validates every field against
/// a closed vocabulary, so a malformed call is rejected, not stored.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn suggestion_outcome_log<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    state: tauri::State<'_, StoreState>,
    pattern_id: String,
    workflow_id: Option<String>,
    pack_domain: Option<String>,
    cadence: Option<String>,
    surface: Option<String>,
    outcome: String,
    reason: Option<String>,
    local_dow: i64,
    local_hour: i64,
    cadence_phase: Option<String>,
    seconds_since_trigger: Option<i64>,
) -> Result<(), String> {
    require_panel(&window)?;
    let guard = store_guard(&app, &state).await?;
    guard
        .as_ref()
        .expect("initialized")
        .suggestion_outcome_log(
            &pattern_id,
            workflow_id.as_deref(),
            pack_domain.as_deref(),
            cadence.as_deref(),
            surface.as_deref(),
            &outcome,
            reason.as_deref(),
            local_dow,
            local_hour,
            cadence_phase.as_deref(),
            seconds_since_trigger,
        )
        .await
        .map_err(|e| e.to_string())
}

/// How many Layer 5 outcome rows exist locally — shown in Privacy so the size
/// of the on-device training set is visible rather than implied.
#[tauri::command]
async fn suggestion_outcome_count<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    state: tauri::State<'_, StoreState>,
) -> Result<i64, String> {
    require_panel(&window)?;
    let guard = store_guard(&app, &state).await?;
    guard
        .as_ref()
        .expect("initialized")
        .suggestion_outcome_count()
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

            // The answer to a pushed action. It arrives on a fresh connection —
            // the extension replies through the ordinary extension → host → desktop
            // path — so it is matched to the waiting thread by `request_id`.
            //
            // Only the correlation field is checked here. The result is relayed to
            // the webview verbatim and parsed there against
            // `browserActionResultSchema`, because strict validation belongs where
            // the contract lives; treating extension output as trusted merely
            // because its HMAC verified would be the wrong lesson from the
            // signature. The signature proves the sender, not the shape.
            if payload.get("type").and_then(|v| v.as_str()) == Some("browser_action_result") {
                let Some(result) = payload.get("result") else {
                    return serde_json::json!({"ok": false, "error": "missing result"});
                };
                let Some(request_id) = result.get("request_id").and_then(|v| v.as_str()) else {
                    return serde_json::json!({"ok": false, "error": "missing request_id"});
                };
                let delivered = browser_relay::relay().deliver(request_id, result.clone());
                return serde_json::json!({"ok": true, "delivered": delivered});
            }

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
        // A THREAD PER CONNECTION, and each connection may carry MANY lines.
        //
        // Both changes are required by the relay: its connection stays open for the
        // life of the browser session. Serving connections one at a time from this
        // loop — which is what it used to do — would mean the relay's own
        // connection blocked every other one behind it, including the event
        // forwarding that was working before.
        for stream in listener.incoming().flatten() {
            let app = app.clone();
            std::thread::spawn(move || serve_bridge_connection(app, stream));
        }
    });
}

/// One bridge connection: read JSON lines until the peer goes away.
fn serve_bridge_connection<R: Runtime>(app: AppHandle<R>, stream: std::os::unix::net::UnixStream) {
    use std::io::{BufRead, BufReader, Write};
    let Ok(read_half) = stream.try_clone() else { return };
    let mut writer = stream;
    for line in BufReader::new(read_half).lines() {
        let Ok(line) = line else { return };
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<serde_json::Value>(&line) {
            Ok(request) => {
                // `relay_register` is handled HERE rather than in
                // `handle_bridge_request` because it is the only request whose
                // effect is to keep the connection itself — the handler only sees
                // parsed JSON and has no way to hand over a socket.
                if request.get("type").and_then(|v| v.as_str()) == Some("relay_register") {
                    register_relay(&writer, &request)
                } else {
                    handle_bridge_request(&app, &request)
                }
            }
            Err(e) => serde_json::json!({"ok": false, "error": format!("bad json: {e}")}),
        };
        if writer.write_all(format!("{reply}\n").as_bytes()).is_err() {
            return;
        }
    }
}

/// Takes over the push channel for the extension that just identified itself.
fn register_relay(
    stream: &std::os::unix::net::UnixStream,
    request: &serde_json::Value,
) -> serde_json::Value {
    let Some(installation_id) = request.get("installation_id").and_then(|v| v.as_str()) else {
        return serde_json::json!({"ok": false, "error": "missing installation_id"});
    };
    // Registration is NOT authentication and grants nothing: a registered relay can
    // only carry envelopes the desktop signed, to an extension that verifies them.
    // The worst a bogus registration achieves is taking delivery of requests it
    // cannot read the intent of and cannot answer, which surfaces as a timeout.
    let Ok(write_half) = stream.try_clone() else {
        return serde_json::json!({"ok": false, "error": "cannot clone socket"});
    };
    browser_relay::relay().register(write_half, installation_id);
    serde_json::json!({"ok": true})
}

/// Starts a Teach Mode capture session.
///
/// Three gates, all here rather than deeper down, so a refusal is immediate and
/// legible: the panel must be the caller, the user must have enabled Teach Mode,
/// and the request must name a bounded time box and at least one app. The observer
/// re-checks every one of them per frame; this is the early, honest "no".
#[tauri::command]
fn teach_mode_start<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    max_seconds: u32,
    scope_bundle_ids: Vec<String>,
) -> Result<String, String> {
    require_panel(&window)?;

    // The setting is the standing consent. Without it there is no session, and no
    // amount of asking from the webview changes that.
    if !load_gate_settings(&app).teach_mode_enabled {
        return Err("Teach Mode is off — enable it in Privacy first".into());
    }
    if scope_bundle_ids.is_empty() {
        return Err("a session must name at least one app to demonstrate in".into());
    }
    // Matches the observer's protocol bound; a session is not something you can
    // leave running.
    if max_seconds == 0 || max_seconds > 900 {
        return Err("a session lasts between 1 and 900 seconds".into());
    }
    if !observer::ObserverGate::should_observe(&load_observer_gate(&app)) {
        return Err("observation is paused or consent is incomplete".into());
    }

    let session_id = uuid_v4_like(&browser_bridge::sha256_hex(
        format!("teach:{}", browser_bridge::now_unix_ms()).as_bytes(),
    ));
    let line = serde_json::json!({
        "type": "teach_mode_start",
        "session_id": session_id,
        "max_seconds": max_seconds,
        "scope_bundle_ids": scope_bundle_ids,
    })
    .to_string();
    queue_teach_control(&app, line)?;
    Ok(session_id)
}

/// Stops the running session immediately. Never fails on "nothing running" — a
/// stop the user asked for should not report an error for having been redundant.
#[tauri::command]
fn teach_mode_stop<R: Runtime>(app: AppHandle<R>, window: Window<R>) -> Result<(), String> {
    require_panel(&window)?;
    queue_teach_control(&app, "{\"type\":\"teach_mode_stop\"}".to_string())
}

fn queue_teach_control<R: Runtime>(app: &AppHandle<R>, line: String) -> Result<(), String> {
    let state = app
        .try_state::<TeachControlState>()
        .ok_or("teach control channel unavailable")?;
    let mut queue = state.0.lock().map_err(|_| "teach control channel poisoned")?;
    // A bounded queue: if the observer is not draining, the session is not running
    // and piling up start lines would only start a burst later.
    if queue.len() >= 8 {
        return Err("teach control queue is full — the observer is not running".into());
    }
    queue.push(line);
    Ok(())
}

/// Whether a browser relay is currently connected, for the run UI to show before
/// it offers a browser-lane step.
#[tauri::command]
fn browser_relay_status<R: Runtime>(window: Window<R>) -> Result<serde_json::Value, String> {
    require_panel(&window)?;
    Ok(serde_json::json!({
        "connected": browser_relay::relay().is_connected(),
        "in_flight": browser_relay::relay().pending_count(),
    }))
}

/// Pushes ONE approved browser action to the extension and returns its result.
///
/// The request arrives already built and policy-checked by the run path — this
/// command is transport, and deliberately adds no judgement of its own. What it
/// does add is the signature: the extension must be able to tell a request from
/// the desktop apart from anything the native host could have injected, and the
/// host holds no key material precisely so that it cannot.
///
/// Panel-only. The status bar webview must not be able to drive the browser.
#[tauri::command]
async fn browser_action_dispatch<R: Runtime>(
    window: Window<R>,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    require_panel(&window)?;

    let request_id = request
        .get("request_id")
        .and_then(|v| v.as_str())
        .ok_or("request must carry request_id")?
        .to_string();

    let secret = keyring::Entry::new(KEYCHAIN_SERVICE, browser_bridge::BROWSER_SECRET_ACCOUNT)
        .and_then(|e| e.get_password())
        .map_err(|_| "not paired with a browser".to_string())?;
    let installation_id = browser_relay::relay()
        .installation_id()
        .ok_or("no browser relay connected")?;

    let now = browser_bridge::now_unix_ms();
    let mut nonce_bytes = [0u8; 16];
    use rand::RngCore;
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = browser_bridge::base64url_encode(&nonce_bytes);
    let message_id = uuid_v4_like(&browser_bridge::sha256_hex(
        format!("{request_id}:{now}:{nonce}").as_bytes(),
    ));

    let envelope = browser_bridge::sign_envelope_hmac(
        &message_id,
        &installation_id,
        &store::iso_from_unix_ms(now),
        &nonce,
        serde_json::json!({ "type": "browser_action_request", "request": request }),
        &secret,
    )
    .ok_or("cannot sign the action request")?;

    // Interest is registered BEFORE the push: the extension can answer faster than
    // this thread gets back from `push`, and a result with no waiter is dropped.
    tauri::async_runtime::spawn_blocking(move || {
        let relay = browser_relay::relay();
        let rx = relay.begin(&request_id);
        if let Err(e) = relay.push(&envelope) {
            relay.abandon(&request_id);
            return Err(e);
        }
        relay.wait(&request_id, rx, browser_relay::ACTION_TIMEOUT)
    })
    .await
    .map_err(|e| format!("dispatch thread failed: {e}"))?
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

/// Control lines waiting to be written to the observer's stdin.
///
/// The supervisor owns that pipe inside its loop, so a Tauri command cannot write
/// to it directly. Commands push a line here and the supervisor drains it on its
/// existing ~2s tick — which also means a queued line is DROPPED when the observer
/// is not running, rather than starting a session against a dead child.
pub struct TeachControlState(pub std::sync::Mutex<Vec<String>>);

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

/// Handles one masked Teach Mode frame: send it to the vision API, turn the
/// answer into a canonical event, and DROP THE PIXELS.
///
/// The safety decision already happened in the observer's egress gate, before
/// these bytes crossed the pipe. What is left here is transport and translation,
/// and one rule: `jpeg_b64` is never logged, never persisted, and never attached
/// to the event that results from it.
async fn ingest_teach_frame<R: Runtime>(
    app: &AppHandle<R>,
    client: &reqwest::Client,
    meta: &serde_json::Value,
    jpeg_b64: &str,
) {
    let frame_id = meta.get("frame_id").and_then(|v| v.as_str()).unwrap_or_default();
    let session_id = meta.get("session_id").and_then(|v| v.as_str()).unwrap_or_default();
    if frame_id.is_empty() || session_id.is_empty() {
        return;
    }

    // Model + key come from configuration. Unset means Teach Mode infers nothing
    // rather than guessing a model name in source.
    let api_key = std::env::var("ANTHROPIC_API_KEY").unwrap_or_default();
    let model = std::env::var("ANTHROPIC_VISION_MODEL").unwrap_or_default();

    let outcome = match vision::infer_frame(
        client,
        vision::FrameRequest {
            frame_id,
            session_id,
            jpeg_b64,
            api_key: &api_key,
            model: &model,
        },
    )
    .await
    {
        Ok(v) => v,
        Err(e) => {
            // The reason is safe to surface; the frame is not part of it.
            let _ = app.emit(
                "teach:status",
                serde_json::json!({
                    "session_id": session_id,
                    "state": "inference_failed",
                    "detail": e.to_string(),
                }),
            );
            return;
        }
    };

    // The webview owns interpretation: `interpretVisionResponse` parses this
    // against the strict schema, drops anything under the confidence floor, and
    // builds the canonical event. Model output stays untrusted data all the way
    // through, and the pixels are already gone by this point.
    //
    // `usage` rides along so the panel can show what a session ACTUALLY spent next
    // to what it estimated. An estimate nobody checks is a guess with a decimal
    // point.
    let _ = app.emit(
        "teach:observation",
        serde_json::json!({
            "frame": meta,
            "observation": outcome.observation,
            "usage": {
                "input_tokens": outcome.usage.input_tokens,
                "output_tokens": outcome.usage.output_tokens,
                "cache_read_tokens": outcome.usage.cache_read_tokens,
            },
        }),
    );
}

/// Supervises the observer sidecar: spawns only when the gate allows, streams
/// its JSONL over stdio into the ingest gate, and applies the restart policy.
/// A quiet loop re-checks the gate so pause/consent changes start/stop it.
fn start_observer_supervisor<R: Runtime>(app: AppHandle<R>) {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::process::Command as TokioCommand;

    tauri::async_runtime::spawn(async move {
        let mut policy = observer::RestartPolicy::new();
        // One client for the supervisor's life: connection reuse matters when a
        // Teach session sends a frame every few seconds.
        let vision_client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .unwrap_or_default();
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
            // Pack label patterns change only with the bundled packs, so load once.
            let label_patterns =
                domain::label_patterns(&domain::load_packs(&domain_packs_dir(&app)));
            let mut last_config =
                observer_configure_line(
                    &load_gate_settings(&app),
                    &label_patterns,
                    &app.config().identifier,
                );
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
                    let current_config =
                        observer_configure_line(
                    &load_gate_settings(&app),
                    &label_patterns,
                    &app.config().identifier,
                );
                    if current_config != last_config {
                        last_config = current_config.clone();
                        if let Some(stdin) = control_stdin.as_mut() {
                            let _ = stdin.write_all(format!("{current_config}\n").as_bytes()).await;
                            let _ = stdin.flush().await;
                        }
                    }
                    // Teach Mode start/stop lines queued by the panel.
                    let queued: Vec<String> = app
                        .try_state::<TeachControlState>()
                        .and_then(|s| s.0.lock().ok().map(|mut q| std::mem::take(&mut *q)))
                        .unwrap_or_default();
                    for line in queued {
                        if let Some(stdin) = control_stdin.as_mut() {
                            let _ = stdin.write_all(format!("{line}\n").as_bytes()).await;
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
                            observer::ObserverLine::WindowFrame { frame } => {
                                // Transient UI state only: dock the subtitle bar
                                // to the monitored window. Nothing is stored.
                                dock_statusbar(&app, frame);
                            }
                            observer::ObserverLine::TeachFrame { meta, jpeg_b64 } => {
                                // Awaited rather than spawned: a vision call per
                                // frame, run serially, is what keeps a 15-minute
                                // session from issuing hundreds of concurrent
                                // requests. The observer's own 2.5s cadence plus
                                // its in-flight guard mean nothing queues up here.
                                ingest_teach_frame(&app, &vision_client, &meta, &jpeg_b64).await;
                            }
                            observer::ObserverLine::TeachStatus { session_id, state, detail } => {
                                let _ = app.emit(
                                    "teach:status",
                                    serde_json::json!({
                                        "session_id": session_id,
                                        "state": state,
                                        "detail": detail,
                                    }),
                                );
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
        .manage(KeyAcquireState(store::GuardedKeyAcquire::new()))
        .manage(StoreHealth(std::sync::Mutex::new(StoreStatus::Ok)))
        .manage(ObserverState(std::sync::Mutex::new(ObserverStatus::Disabled)))
        .manage(TeachControlState(std::sync::Mutex::new(Vec::new())))
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
            suggestion_outcome_log,
            watched_dates,
            suggestion_outcome_count,
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
            store_status,
            packs_status,
            statusbar_set_visible,
            statusbar_position_save,
            statusbar_position_reset,
            browser_relay_status,
            teach_mode_start,
            teach_mode_stop,
            browser_action_dispatch,
            statusbar_apply_click_through,
            open_accessibility_settings
        ])
        .setup(|app| {
            make_windows_visible_on_all_spaces(&app.handle().clone());
            setup_statusbar(&app.handle().clone());
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
mod teach_mode_default_tests {
    use super::GateSettings;

    #[test]
    fn teach_mode_is_off_in_a_default_gate_settings() {
        // Every failure path in load_gate_settings falls back to Default. A missing
        // or unparseable settings file must never be the reason screen capture
        // becomes possible, so the default is asserted rather than assumed.
        let defaults = GateSettings::default();
        assert!(!defaults.teach_mode_enabled, "Teach Mode must default to OFF");
        assert!(
            !defaults.observe_all_apps,
            "observe-all must default to OFF for the same reason"
        );
    }
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
            teach_mode_enabled: false,
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
mod store_status_tests {
    use super::{store_status_for_error, store_status_label, StoreStatus};
    use crate::store::StoreError;

    #[test]
    fn keychain_failures_surface_access_required() {
        // Both a hung securityd (timeout) and an explicit denial map to the
        // honest "grant keychain access" state — never a silent hang, never an
        // auto-recreated key (that would orphan the encrypted store).
        assert_eq!(
            store_status_for_error(&StoreError::KeyTimeout),
            StoreStatus::KeychainAccessRequired
        );
        assert_eq!(
            store_status_for_error(&StoreError::Key("user canceled".into())),
            StoreStatus::KeychainAccessRequired
        );
        assert_eq!(
            store_status_for_error(&StoreError::InvalidPayload("x".into())),
            StoreStatus::Failed
        );
        assert_eq!(
            store_status_label(StoreStatus::KeychainAccessRequired),
            "keychain_access_required"
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

#[cfg(test)]
mod label_pattern_tests {
    use super::{observer_configure_line, GateSettings};

    #[test]
    fn configure_line_carries_pack_label_patterns_as_plain_strings() {
        let settings = GateSettings {
            observation_paused: false,
            private_apps: vec![],
            allowlist_domains: vec!["salesforce.com".into()],
            allowlist_bundles: vec!["com.google.Chrome".into()],
            observe_all_apps: false,
            teach_mode_enabled: false,
        };
        let line = observer_configure_line(&settings, &["INV-".into(), "invoice".into()], "com.maman.desktop");
        let json: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(json["type"], "configure");
        assert_eq!(json["label_patterns"], serde_json::json!(["INV-", "invoice"]));
        // No patterns → empty array, never absent (stable change fingerprint).
        let bare = observer_configure_line(&settings, &[], "com.maman.desktop");
        let json: serde_json::Value = serde_json::from_str(&bare).unwrap();
        assert_eq!(json["label_patterns"], serde_json::json!([]));
    }

    #[test]
    fn real_pack_patterns_reach_the_configure_line() {
        let packs = crate::domain::load_packs(
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../domain/packs"),
        );
        let patterns = crate::domain::label_patterns(&packs);
        assert!(patterns.iter().any(|p| p == "invoice"));
        let settings = GateSettings::default();
        let line = observer_configure_line(&settings, &patterns, "com.maman.desktop");
        assert!(line.contains("label_patterns"));
        assert!(line.contains("invoice"));
    }
}

#[cfg(test)]
mod statusbar_placement_tests {
    //! The status bar shipped positioned against the physical bottom edge, which
    //! on macOS puts it BEHIND the Dock (the Dock draws above ordinary
    //! always-on-top windows). The health surface was therefore invisible on any
    //! machine with a bottom Dock and auto-hide off — it looked like the feature
    //! had never been built. These tests pin the placement so that cannot recur.
    use super::{statusbar_origin, DOCK_FALLBACK, STATUSBAR_GAP};

    /// A 13" MacBook in its default scaled mode, Dock at the bottom.
    const SCREEN: (i32, i32) = (2560, 1664);
    const WINDOW: (i32, i32) = (836, 70); // 480x40 logical at ~1.74x
    /// macOS reports a work area that excludes the menu bar and the Dock.
    const WORK_SIZE: (i32, i32) = (2560, 1470);

    #[test]
    fn sits_inside_the_work_area_never_in_the_dock_strip() {
        let (x, y) = statusbar_origin((0, 44), WORK_SIZE, (0, 0), SCREEN, WINDOW);
        // Bottom edge of the bar must stay within the work area…
        assert!(y + WINDOW.1 <= 44 + WORK_SIZE.1, "bar overflows the work area");
        // …and must NOT reach into the strip the Dock occupies.
        let dock_top = 44 + WORK_SIZE.1;
        assert!(y + WINDOW.1 <= dock_top, "bar would be hidden behind the Dock");
        // Horizontally centered.
        assert_eq!(x, (SCREEN.0 - WINDOW.0) / 2);
    }

    #[test]
    fn is_flush_against_the_bottom_of_the_usable_area() {
        let (_, y) = statusbar_origin((0, 44), WORK_SIZE, (0, 0), SCREEN, WINDOW);
        assert_eq!(y, 44 + WORK_SIZE.1 - WINDOW.1 - STATUSBAR_GAP);
    }

    #[test]
    fn respects_a_dock_on_the_left_by_using_the_work_area_origin() {
        // A left Dock shifts the work area's x origin and narrows it.
        let (x, _) = statusbar_origin((160, 44), (2400, 1620), (0, 0), SCREEN, WINDOW);
        assert_eq!(x, 160 + (2400 - WINDOW.0) / 2);
        assert!(x > 160, "bar must start right of a left-hand Dock");
    }

    #[test]
    fn falls_back_to_a_dock_sized_margin_when_the_work_area_is_unusable() {
        // Platforms that report a zero/absurd work area must not park the bar at
        // the very bottom — that is exactly the original bug.
        for bad in [(0, 0), (2560, 10)] {
            let (_, y) = statusbar_origin((0, 0), bad, (0, 0), SCREEN, WINDOW);
            assert_eq!(y, SCREEN.1 - DOCK_FALLBACK - WINDOW.1 - STATUSBAR_GAP);
            assert!(
                y + WINDOW.1 < SCREEN.1 - 60,
                "fallback must still clear a Dock-sized strip"
            );
        }
    }

    #[test]
    fn handles_a_secondary_monitor_with_a_negative_origin() {
        // A display left of the primary has negative coordinates; the bar must
        // land on THAT display, not at x≈0 on the primary.
        let (x, y) = statusbar_origin((-1920, 0), (1920, 1080), (-1920, 0), (1920, 1080), WINDOW);
        assert!(x < 0, "bar must stay on the left-hand display");
        assert_eq!(x, -1920 + (1920 - WINDOW.0) / 2);
        assert_eq!(y, 1080 - WINDOW.1 - STATUSBAR_GAP);
    }
}

#[cfg(test)]
mod statusbar_docking_tests {
    //! Docking the subtitle bar to the window being monitored. The clamp is the
    //! part that matters: a window can be dragged half off-screen or be shorter
    //! than the bar, and the bar must stay visible rather than follow it away.
    use super::{statusbar_origin_in_window, DOCK_INSET};

    /// Logical points: 1470x956 usable, menu bar 25pt, Dock ~70pt.
    const WORK: (f64, f64, f64, f64) = (0.0, 25.0, 1470.0, 861.0);
    const BAR: (f64, f64) = (480.0, 40.0);

    #[test]
    fn centers_on_the_monitored_window_just_inside_its_bottom_edge() {
        let window = (200.0, 100.0, 900.0, 600.0);
        let (x, y) = statusbar_origin_in_window(window, BAR, WORK);
        assert_eq!(x, 200.0 + (900.0 - 480.0) / 2.0, "centered horizontally");
        assert_eq!(y, 100.0 + 600.0 - 40.0 - DOCK_INSET, "just inside the bottom");
        // Inside the window, not below it.
        assert!(y + BAR.1 <= 100.0 + 600.0);
    }

    #[test]
    fn follows_the_window_when_it_moves() {
        let (x1, y1) = statusbar_origin_in_window((100.0, 100.0, 800.0, 500.0), BAR, WORK);
        let (x2, y2) = statusbar_origin_in_window((300.0, 200.0, 800.0, 500.0), BAR, WORK);
        assert_eq!(x2 - x1, 200.0);
        assert_eq!(y2 - y1, 100.0);
    }

    #[test]
    fn left_aligns_when_the_window_is_narrower_than_the_bar() {
        let (x, _) = statusbar_origin_in_window((300.0, 100.0, 320.0, 400.0), BAR, WORK);
        assert_eq!(x, 300.0, "no negative centering offset");
    }

    #[test]
    fn clamps_a_window_dragged_off_the_right_edge() {
        // Window mostly off-screen to the right.
        let (x, _) = statusbar_origin_in_window((1400.0, 100.0, 900.0, 500.0), BAR, WORK);
        assert!(x + BAR.0 <= WORK.0 + WORK.2, "bar must stay on screen");
        assert_eq!(x, WORK.2 - BAR.0);
    }

    #[test]
    fn clamps_a_window_dragged_off_the_left_edge() {
        let (x, _) = statusbar_origin_in_window((-600.0, 100.0, 900.0, 500.0), BAR, WORK);
        assert!(x >= WORK.0, "bar must not sit off the left edge");
        assert_eq!(x, 0.0);
    }

    #[test]
    fn clamps_a_window_whose_bottom_is_under_the_dock() {
        // A window extending past the bottom of the usable area.
        let (_, y) = statusbar_origin_in_window((200.0, 500.0, 900.0, 600.0), BAR, WORK);
        assert!(
            y + BAR.1 <= WORK.1 + WORK.3,
            "bar must not be pushed behind the Dock"
        );
        assert_eq!(y, WORK.1 + WORK.3 - BAR.1);
    }

    #[test]
    fn clamps_above_the_menu_bar() {
        // A window positioned above the work area origin (menu bar region).
        let (_, y) = statusbar_origin_in_window((200.0, -200.0, 900.0, 100.0), BAR, WORK);
        assert!(y >= WORK.1, "bar must not overlap the menu bar");
        assert_eq!(y, WORK.1);
    }

    #[test]
    fn never_produces_an_inverted_range_on_an_absurd_work_area() {
        // Work area smaller than the bar: clamping must still yield the origin,
        // not a position derived from a negative max.
        let tiny = (0.0, 0.0, 100.0, 20.0);
        let (x, y) = statusbar_origin_in_window((200.0, 200.0, 900.0, 500.0), BAR, tiny);
        assert_eq!((x, y), (0.0, 0.0));
    }
}

#[cfg(test)]
mod self_observation_tests {
    //! Maman must never observe its own windows.
    //!
    //! Found on-device: with `observe_all_apps` the observer watched Maman's own
    //! panel, pet, and status bar. Two consequences, one silent and one loud —
    //! the event store filled with Maman's own UI as if it were the user's work,
    //! and once the subtitle bar docked to the monitored window, moving the bar
    //! emitted a window-moved notification that moved it again, walking it up the
    //! screen 6pt per iteration (138 iterations in one recorded run).
    use super::{observer_configure_line, GateSettings};

    fn settings(observe_all: bool, private_apps: Vec<String>) -> GateSettings {
        GateSettings {
            observe_all_apps: observe_all,
            allowlist_bundles: vec!["com.google.Chrome".into()],
            allowlist_domains: vec![],
            private_apps,
            ..Default::default()
        }
    }

    fn private_list(line: &str) -> Vec<String> {
        let v: serde_json::Value = serde_json::from_str(line).unwrap();
        v["private_apps"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn own_bundle_is_always_excluded_even_when_observing_every_app() {
        let line = observer_configure_line(&settings(true, vec![]), &[], "com.maman.desktop");
        assert!(
            private_list(&line).contains(&"com.maman.desktop".to_string()),
            "Maman must be in private_apps: {line}"
        );
        // The wildcard is still sent — self-exclusion must not narrow observation.
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["allowlist_bundles"][0], "*");
    }

    #[test]
    fn own_bundle_is_excluded_with_an_explicit_allowlist_too() {
        let line = observer_configure_line(&settings(false, vec![]), &[], "com.maman.desktop");
        assert!(private_list(&line).contains(&"com.maman.desktop".to_string()));
    }

    #[test]
    fn user_private_apps_are_preserved_and_not_duplicated() {
        let line = observer_configure_line(
            &settings(true, vec!["com.apple.mail".into(), "com.maman.desktop".into()]),
            &[],
            "com.maman.desktop",
        );
        let list = private_list(&line);
        assert!(list.contains(&"com.apple.mail".to_string()), "user entry kept");
        assert_eq!(
            list.iter().filter(|a| *a == "com.maman.desktop").count(),
            1,
            "no duplicate self entry: {list:?}"
        );
    }

    #[test]
    fn an_empty_identifier_adds_nothing_rather_than_a_blank_entry() {
        let line = observer_configure_line(&settings(true, vec![]), &[], "");
        assert!(private_list(&line).is_empty(), "blank id must not be added");
    }
}

#[cfg(test)]
mod statusbar_manual_position_tests {
    //! A hand-placed bar must stay where the user put it.
    //!
    //! The bar is draggable, which means two placement authorities now exist: the
    //! automatic one (dock to the monitored window, else the screen anchor) and
    //! the user. The user wins. Without that rule the bar would snap back on the
    //! next focus change and dragging would look broken.
    use super::{statusbar_position_key_for, statusbar_should_auto_place};

    #[test]
    fn automatic_placement_is_allowed_only_while_following() {
        assert!(statusbar_should_auto_place(true), "following: docking may move it");
        assert!(
            !statusbar_should_auto_place(false),
            "hand-placed: nothing may move it"
        );
    }

    #[test]
    fn position_key_is_namespaced_per_display() {
        // Stored beside the pet's positions, so it must not collide with a
        // monitor name used as a bare key.
        assert_eq!(statusbar_position_key_for("Built-in Retina Display"), "statusbar@Built-in Retina Display");
        assert_ne!(statusbar_position_key_for("primary"), "primary");
    }

    #[test]
    fn each_display_remembers_its_own_spot() {
        assert_ne!(
            statusbar_position_key_for("Built-in Retina Display"),
            statusbar_position_key_for("DELL U2720Q"),
        );
    }
}

#[cfg(test)]
mod statusbar_clamp_tests {
    //! A hand-placed bar outranks automatic placement, but not the requirement to
    //! be reachable. On-device the bar sat at logical (0, 850) — a faithfully
    //! restored manual position that was nonetheless behind another window and in
    //! a corner, with nothing in the code able to pull it back.
    use super::clamp_into_area;

    /// Physical pixels for a 1470x956 logical display at scale 2: menu bar 33pt,
    /// Dock ~65pt, so the usable area is y 66..1782.
    const AREA: (i32, i32, i32, i32) = (0, 66, 2940, 1716);
    const BAR: (i32, i32) = (960, 80);

    #[test]
    fn leaves_a_position_that_is_already_fully_visible() {
        assert_eq!(clamp_into_area((500, 900), BAR, AREA), (500, 900));
    }

    #[test]
    fn pulls_back_a_bar_dragged_past_the_right_edge() {
        let (x, _) = clamp_into_area((2900, 900), BAR, AREA);
        assert_eq!(x, AREA.2 - BAR.0, "right edge, fully on screen");
        assert!(x + BAR.0 <= AREA.0 + AREA.2);
    }

    #[test]
    fn pulls_back_a_bar_dragged_below_the_usable_area() {
        // Past the Dock: the exact failure that made the bar unreachable.
        let (_, y) = clamp_into_area((500, 1900), BAR, AREA);
        assert_eq!(y, AREA.1 + AREA.3 - BAR.1);
        assert!(y + BAR.1 <= AREA.1 + AREA.3);
    }

    #[test]
    fn pulls_back_negative_coordinates_and_the_menu_bar_strip() {
        assert_eq!(clamp_into_area((-500, -500), BAR, AREA), (0, 66));
    }

    #[test]
    fn survives_a_display_that_shrank_below_the_bar_size() {
        // A position saved on a bigger display, restored on a tiny one: pin to the
        // origin rather than computing a negative maximum.
        let tiny = (0, 0, 200, 40);
        assert_eq!(clamp_into_area((1500, 1500), BAR, tiny), (0, 0));
    }

    #[test]
    fn respects_a_secondary_display_origin() {
        // A display left of the primary has negative coordinates; clamping must
        // keep the bar on THAT display, not drag it to x=0.
        let left = (-2940, 0, 2940, 1716);
        let (x, y) = clamp_into_area((-2000, 800), BAR, left);
        assert_eq!((x, y), (-2000, 800));
        assert_eq!(clamp_into_area((-5000, 800), BAR, left).0, -2940);
    }
}
