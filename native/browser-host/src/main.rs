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

/// Path of the installed native-messaging manifest (the file Chrome itself
/// reads to decide it may launch us).
fn manifest_paths() -> Vec<PathBuf> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    let name = "com.maman.browser_host.json";
    [
        "Library/Application Support/Google/Chrome/NativeMessagingHosts",
        "Library/Application Support/Chromium/NativeMessagingHosts",
        "Library/Application Support/Microsoft Edge/NativeMessagingHosts",
        "Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts",
    ]
    .iter()
    .map(|dir| PathBuf::from(&home).join(dir).join(name))
    .collect()
}

/// Extension ids parsed out of a manifest's `allowed_origins`.
fn ids_from_manifest(text: &str) -> Vec<String> {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(text) else {
        return Vec::new();
    };
    json.get("allowed_origins")
        .and_then(|v| v.as_array())
        .map(|origins| {
            origins
                .iter()
                .filter_map(|o| o.as_str())
                .filter_map(|o| {
                    o.strip_prefix("chrome-extension://")
                        .map(|rest| rest.trim_end_matches('/').to_string())
                })
                .filter(|id| !id.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// Allowed extension IDs. The INSTALLED NATIVE-MESSAGING MANIFEST is the
/// authority: it is the same file Chrome consults before launching this host,
/// and only the installer writes it (anyone who could rewrite it could already
/// repoint `path` at their own binary, so reading it adds no trust). The
/// MAMAN_ALLOWED_EXTENSION_IDS env var overrides it for tests; the documented
/// development id is the last-resort fallback.
///
/// Chrome cannot pass env vars to a native host, so the env var alone would
/// always fall back and deny every real extension — an on-device pass caught
/// exactly that.
fn allowed_extension_ids() -> Vec<String> {
    if let Ok(ids) = std::env::var("MAMAN_ALLOWED_EXTENSION_IDS") {
        let parsed: Vec<String> = ids
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        if !parsed.is_empty() {
            return parsed;
        }
    }
    let mut ids: Vec<String> = manifest_paths()
        .iter()
        .filter_map(|p| std::fs::read_to_string(p).ok())
        .flat_map(|text| ids_from_manifest(&text))
        .collect();
    ids.sort();
    ids.dedup();
    if ids.is_empty() {
        ids.push("maman-dev-extension-id".to_string());
    }
    ids
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

#[cfg(test)]
mod manifest_allowlist_tests {
    use super::ids_from_manifest;

    #[test]
    fn parses_extension_ids_from_allowed_origins() {
        let manifest = r#"{
          "name": "com.maman.browser_host",
          "allowed_origins": ["chrome-extension://ndgljknidknbakdjbhebbhlhclafngil/"]
        }"#;
        assert_eq!(
            ids_from_manifest(manifest),
            vec!["ndgljknidknbakdjbhebbhlhclafngil".to_string()]
        );
    }

    #[test]
    fn ignores_non_extension_origins_and_malformed_manifests() {
        let manifest = r#"{
          "allowed_origins": ["https://evil.example/", "chrome-extension://", "chrome-extension://good0000000000000000000000000000/"]
        }"#;
        assert_eq!(
            ids_from_manifest(manifest),
            vec!["good0000000000000000000000000000".to_string()]
        );
        assert!(ids_from_manifest("not json").is_empty());
        assert!(ids_from_manifest(r#"{"allowed_origins": "nope"}"#).is_empty());
        assert!(ids_from_manifest("{}").is_empty());
    }
}
