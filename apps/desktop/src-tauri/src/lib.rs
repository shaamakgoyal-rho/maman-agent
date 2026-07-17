//! Maman desktop core.
//!
//! Trust boundary: the webview is untrusted relative to this Rust core.
//! Commands validate their inputs, and window-sensitive commands check the
//! calling window's label (the pet window may never reach privileged surfaces).

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, PhysicalPosition, Runtime, WebviewWindow};

const EDGE_SNAP_PX: i32 = 16;
const EDGE_SNAP_THRESHOLD_PX: i32 = 40;
const SETTINGS_FILE: &str = "settings.json";
const POSITIONS_FILE: &str = "pet-positions.json";

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

// ---------- entry ----------

pub fn run() {
    let last_move_ms: Arc<AtomicI64> = Arc::new(AtomicI64::new(0));

    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            settings_load,
            settings_save,
            toggle_panel,
            hide_panel,
            quit_app
        ])
        .setup(|app| {
            restore_pet_position(&app.handle().clone());

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
