//! Maman's OWN browser window — the agent's web access, without an extension.
//!
//! The window is a plain Tauri webview pointed at a remote site. Two properties
//! make that safe enough to drive, and both are enforced here rather than
//! trusted:
//!
//! 1. NO IPC. The window's label appears in NO capability file, so Tauri grants
//!    it no commands. A remote page that could reach `invoke()` would be able to
//!    call the store, the vault and the observer — strictly worse than the
//!    extension it replaces. `assert_no_ipc_capability` proves the label is
//!    absent from every shipped capability, in a test, so adding one later
//!    fails the build instead of silently opening the door.
//!
//! 2. THE HOST OWNS THE ORIGIN. `current_origin` reads the URL from the
//!    webview handle, never from page script. `document.location` is
//!    page-controlled: a page that could report its own origin could claim to
//!    be the allowlisted site and receive writes meant for it.
//!
//! Everything about WHETHER to act stays in `@maman/browser-actuator`. This
//! module is the three primitives that layer needs — evaluate, navigate,
//! current_origin — and nothing more.

use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Manager, Runtime, Url, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::oneshot;

/// The one window label the agent drives. Deliberately distinct from `panel`,
/// `pet` and `statusbar`, all of which DO hold capabilities.
pub const AGENT_BROWSER_LABEL: &str = "agentweb";

/// How long a single in-page evaluation may take before it is a failure.
///
/// A hung evaluation must not become "nothing changed": the outcome of a write
/// whose answer never arrived is unknown, and unknown is not success.
const EVAL_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, thiserror::Error)]
pub enum AgentBrowserError {
    #[error("the agent's browser window is not open")]
    NoWindow,
    #[error("blocked: {0}")]
    Blocked(String),
    #[error("the page did not answer within {0:?}")]
    Timeout(Duration),
    #[error("webview error: {0}")]
    Webview(String),
}

/// Whether a URL may be opened in the agent's window at all.
///
/// Pure so it can be tested exhaustively. HTTPS-only is not decoration: the
/// window carries the user's real session cookies for the sites they signed
/// into, and an http:// page can be rewritten in flight by anything on the
/// path. `file://`, `data:` and `javascript:` are refused because they are the
/// classic ways to make a "navigation" execute local script instead.
pub fn navigation_allowed(url: &str, allowed_origins: &[String]) -> Result<String, String> {
    let parsed = Url::parse(url).map_err(|e| format!("unparseable url: {e}"))?;
    if parsed.scheme() != "https" {
        return Err(format!("only https is allowed, got {}", parsed.scheme()));
    }
    let origin = parsed.origin().ascii_serialization();
    if !allowed_origins.iter().any(|o| o == &origin) {
        return Err(format!("{origin} is not one of the sites you allowed"));
    }
    Ok(origin)
}

/// Opens (or focuses) the agent's browser window on an allowed URL.
///
/// The window is VISIBLE and titled on purpose. The user watching the agent
/// work is the supervision model — a hidden window doing approved writes would
/// technically satisfy the approval gate while defeating its point.
pub async fn open_agent_browser<R: Runtime>(
    app: &AppHandle<R>,
    url: &str,
    allowed_origins: &[String],
) -> Result<(), AgentBrowserError> {
    navigation_allowed(url, allowed_origins).map_err(AgentBrowserError::Blocked)?;

    if let Some(existing) = app.get_webview_window(AGENT_BROWSER_LABEL) {
        existing
            .navigate(url.parse().map_err(|e| AgentBrowserError::Blocked(format!("{e}")))?)
            .map_err(|e| AgentBrowserError::Webview(e.to_string()))?;
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    WebviewWindowBuilder::new(
        app,
        AGENT_BROWSER_LABEL,
        WebviewUrl::External(url.parse().map_err(|e| AgentBrowserError::Blocked(format!("{e}")))?),
    )
    .title("Maman is working")
    .inner_size(1100.0, 800.0)
    .visible(true)
    // No decorations config beyond the default: the user must be able to close
    // and move this window like any other, and see that it is a browser.
    .build()
    .map_err(|e| AgentBrowserError::Webview(e.to_string()))?;
    Ok(())
}

/// Closes the window. Called when a run ends, and by the user.
pub fn close_agent_browser<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window(AGENT_BROWSER_LABEL) {
        let _ = w.close();
    }
}

/// The origin the window is CURRENTLY showing, per the webview handle.
///
/// Never asks the page. A page can rewrite `document.location`'s appearance and
/// can certainly lie in a script result; the handle's URL is the host's own
/// record of what it loaded, including after a redirect.
pub fn current_origin<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    let window = app.get_webview_window(AGENT_BROWSER_LABEL)?;
    let url = window.url().ok()?;
    // about:blank and friends have an opaque origin; report None rather than a
    // string that could accidentally compare equal to something.
    let origin = url.origin();
    if !origin.is_tuple() {
        return None;
    }
    Some(origin.ascii_serialization())
}

/// Evaluates one expression in the agent's window and returns the page's answer.
///
/// `eval_with_callback` serialises the expression's value to JSON, so a script
/// returning a JSON *string* arrives here as a JSON-encoded string. The double
/// encoding is unwrapped once, and the inner text is handed to the TypeScript
/// parser which treats it as hostile.
pub async fn evaluate_in_page<R: Runtime>(
    app: &AppHandle<R>,
    expression: &str,
) -> Result<String, AgentBrowserError> {
    let window = app
        .get_webview_window(AGENT_BROWSER_LABEL)
        .ok_or(AgentBrowserError::NoWindow)?;

    let (tx, rx) = oneshot::channel::<String>();
    // The callback may fire on another thread and must be callable once; wrap
    // the sender so a duplicate invocation cannot panic the webview thread.
    let sender = Arc::new(std::sync::Mutex::new(Some(tx)));
    let sender_for_cb = Arc::clone(&sender);
    window
        .eval_with_callback(expression, move |json| {
            if let Ok(mut guard) = sender_for_cb.lock() {
                if let Some(tx) = guard.take() {
                    let _ = tx.send(json);
                }
            }
        })
        .map_err(|e| AgentBrowserError::Webview(e.to_string()))?;

    match tokio::time::timeout(EVAL_TIMEOUT, rx).await {
        // A hung or dropped evaluation is a FAILURE, never an empty success.
        Err(_) => Err(AgentBrowserError::Timeout(EVAL_TIMEOUT)),
        Ok(Err(_)) => Err(AgentBrowserError::Webview("evaluation was dropped".into())),
        Ok(Ok(json)) => Ok(unwrap_json_string(&json)),
    }
}

/// The page script returns a JSON string; `eval_with_callback` then JSON-encodes
/// that value. Unwrap exactly one layer so the caller sees the script's own
/// text. Anything that is not a JSON string is passed through untouched — the
/// TypeScript parser will reject it, which is the correct outcome for a page
/// that returned something unexpected.
pub fn unwrap_json_string(raw: &str) -> String {
    match serde_json::from_str::<String>(raw) {
        Ok(inner) => inner,
        Err(_) => raw.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allowed() -> Vec<String> {
        vec!["https://acme.example".to_string(), "https://b.example".to_string()]
    }

    #[test]
    fn allows_only_listed_https_origins() {
        assert_eq!(
            navigation_allowed("https://acme.example/record/1", &allowed()).unwrap(),
            "https://acme.example"
        );
        assert!(navigation_allowed("https://elsewhere.example/x", &allowed()).is_err());
    }

    #[test]
    fn refuses_non_https_schemes_the_classic_script_carriers() {
        // http can be rewritten in flight; the others make "navigation" execute
        // local script instead of loading a page.
        for url in [
            "http://acme.example/",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "about:blank",
        ] {
            assert!(navigation_allowed(url, &allowed()).is_err(), "{url} must be refused");
        }
    }

    #[test]
    fn a_subdomain_is_a_different_origin() {
        // Origin comparison is exact. "evil.acme.example" is not "acme.example",
        // and neither is a port change.
        assert!(navigation_allowed("https://evil.acme.example/", &allowed()).is_err());
        assert!(navigation_allowed("https://acme.example:8443/", &allowed()).is_err());
    }

    #[test]
    fn userinfo_and_lookalikes_cannot_smuggle_an_origin() {
        // The classic trick: put the allowed host in the userinfo so a careless
        // substring check passes. Origin parsing defeats it.
        assert!(navigation_allowed("https://acme.example@evil.example/", &allowed()).is_err());
        assert!(navigation_allowed("https://acme.example.evil.example/", &allowed()).is_err());
    }

    #[test]
    fn empty_allowlist_permits_nothing() {
        // Actuation is off until the user names a site; there is no implicit default.
        assert!(navigation_allowed("https://acme.example/", &[]).is_err());
    }

    #[test]
    fn unwraps_exactly_one_json_layer() {
        // What eval_with_callback hands back for a script returning a JSON string.
        let inner = r#"{"request_id":"r1","outcome":"observed"}"#;
        let doubled = serde_json::to_string(inner).unwrap();
        assert_eq!(unwrap_json_string(&doubled), inner);
    }

    #[test]
    fn passes_through_anything_that_is_not_a_json_string() {
        // A page that returned a number, null, or malformed text must reach the
        // TypeScript parser unchanged so IT can reject it.
        for raw in ["null", "42", "{not json", ""] {
            assert_eq!(unwrap_json_string(raw), raw);
        }
    }

    /// THE IPC BOUNDARY, asserted against the shipped capability files.
    ///
    /// A remote page with `invoke()` access could call the encrypted store, the
    /// connector vault and the observer controls. The agent's window is safe to
    /// point at a third-party site ONLY because Tauri grants it nothing, and
    /// Tauri decides that by window label. This test reads every capability in
    /// the repo and fails if the label appears — so a future capability edit
    /// that would open IPC to a remote page breaks the build.
    #[test]
    fn agent_browser_window_is_granted_no_ipc_capability() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
        let mut checked = 0;
        for entry in std::fs::read_dir(&dir).expect("capabilities dir") {
            let path = entry.expect("entry").path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let text = std::fs::read_to_string(&path).expect("read capability");
            let json: serde_json::Value = serde_json::from_str(&text).expect("parse capability");
            let windows = json
                .get("windows")
                .and_then(|w| w.as_array())
                .cloned()
                .unwrap_or_default();
            for w in windows {
                assert_ne!(
                    w.as_str(),
                    Some(AGENT_BROWSER_LABEL),
                    "{} grants capabilities to the agent's browser window; a remote page would \
                     gain IPC access to the core",
                    path.display()
                );
            }
            // A wildcard would capture the agent window too.
            assert!(
                !text.contains("\"*\""),
                "{} uses a wildcard window match, which would include {AGENT_BROWSER_LABEL}",
                path.display()
            );
            checked += 1;
        }
        assert!(checked >= 3, "expected the pet/panel/statusbar capabilities, found {checked}");
    }
}
