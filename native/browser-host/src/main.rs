//! Maman native browser host.
//!
//! Chrome launches this binary and speaks native messaging over stdio.
//! Responsibilities (spec §7 browser host):
//! - strict extension-origin allowlist (argv origin + installed manifest)
//! - schema validation, 60s timestamp window, nonce replay cache
//! - forward validated envelopes to the running Tauri core over a local
//!   Unix domain socket (JSON lines)
//! - NO direct server access, NO connector access, NO key material
//!   (HMAC verification happens in the desktop core, which holds the secret)

mod protocol;

use protocol::{
    now_ms, origin_allowed, read_frame, validate_envelope, write_frame, NonceCache,
};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;

fn socket_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    PathBuf::from(home)
        .join("Library/Application Support/com.maman.desktop/browser-host.sock")
}

/// Allowed extension IDs: production ID baked at install time via the
/// MAMAN_ALLOWED_EXTENSION_IDS env var written into the native host manifest
/// wrapper, falling back to the documented development ID.
fn allowed_extension_ids() -> Vec<String> {
    std::env::var("MAMAN_ALLOWED_EXTENSION_IDS")
        .map(|ids| ids.split(',').map(|s| s.trim().to_string()).collect())
        .unwrap_or_else(|_| vec!["maman-dev-extension-id".to_string()])
}

fn desktop_request(request: &serde_json::Value) -> Result<serde_json::Value, String> {
    let mut stream = UnixStream::connect(socket_path())
        .map_err(|e| format!("desktop core unavailable: {e}"))?;
    let line = serde_json::to_string(request).map_err(|e| e.to_string())?;
    stream
        .write_all(format!("{line}\n").as_bytes())
        .map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(stream);
    let mut response = String::new();
    reader.read_line(&mut response).map_err(|e| e.to_string())?;
    serde_json::from_str(&response).map_err(|e| e.to_string())
}

fn main() {
    let origin = std::env::args().nth(1);
    let allowed = allowed_extension_ids();
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut reader = stdin.lock();
    let mut writer = stdout.lock();
    let mut nonce_cache = NonceCache::default();

    if !origin_allowed(origin.as_deref(), &allowed) {
        let _ = write_frame(
            &mut writer,
            &serde_json::json!({ "ok": false, "error": "origin_denied" }),
        );
        return;
    }

    loop {
        let message = match read_frame(&mut reader) {
            Ok(Some(m)) => m,
            Ok(None) => return, // Chrome closed the pipe
            Err(e) => {
                let _ = write_frame(
                    &mut writer,
                    &serde_json::json!({ "ok": false, "error": e.to_string() }),
                );
                continue;
            }
        };

        let reply = handle_message(&message, origin.as_deref().unwrap_or(""), &mut nonce_cache);
        let _ = write_frame(&mut writer, &reply);
    }
}

fn handle_message(
    message: &serde_json::Value,
    origin: &str,
    nonce_cache: &mut NonceCache,
) -> serde_json::Value {
    let msg_type = message.get("type").and_then(|v| v.as_str());

    // Pairing: token verified and consumed by the desktop core.
    if msg_type == Some("pair_request") {
        let request = serde_json::json!({
            "type": "pair_check",
            "origin": origin,
            "extension_id": message.get("extension_id"),
            "installation_id": message.get("installation_id"),
            "token": message.get("token"),
        });
        return match desktop_request(&request) {
            Ok(response) => response,
            Err(e) => serde_json::json!({ "ok": false, "error": e }),
        };
    }

    // Everything else must be a signed envelope.
    match validate_envelope(message, nonce_cache, now_ms()) {
        Ok(_) => {
            let request = serde_json::json!({
                "type": "envelope",
                "origin": origin,
                "envelope": message,
            });
            match desktop_request(&request) {
                Ok(response) => response,
                Err(e) => serde_json::json!({ "ok": false, "error": e }),
            }
        }
        Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
    }
}
