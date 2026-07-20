//! Device → server sync client.
//!
//! Every device→server call originates HERE, in the Rust core — never in the
//! webview. The device token lives in the OS keychain and is attached as a
//! Bearer header by this module; JS never sees it. HTTP goes through an
//! injectable `HttpTransport` so the client logic is unit-tested without a
//! network (the production transport is reqwest with rustls, no system OpenSSL).

use serde_json::{json, Value};

use crate::store::LocalStore;

#[derive(Debug)]
pub enum SyncError {
    Transport(String),
    Unauthorized,
    Server(u16),
    Decode(String),
    Store(String),
}

impl std::fmt::Display for SyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SyncError::Transport(m) => write!(f, "transport error: {m}"),
            SyncError::Unauthorized => write!(f, "unauthorized"),
            SyncError::Server(s) => write!(f, "server error {s}"),
            SyncError::Decode(m) => write!(f, "decode error: {m}"),
            SyncError::Store(m) => write!(f, "store error: {m}"),
        }
    }
}

pub struct HttpRequest {
    pub method: &'static str,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Value>,
}

pub struct HttpResponse {
    pub status: u16,
    pub body: Value,
}

#[allow(async_fn_in_trait)]
pub trait HttpTransport {
    async fn send(&self, req: HttpRequest) -> Result<HttpResponse, SyncError>;
}

/// Production transport: reqwest with rustls. No system OpenSSL dependency.
pub struct ReqwestTransport {
    client: reqwest::Client,
}

impl ReqwestTransport {
    pub fn new() -> Result<Self, SyncError> {
        let client = reqwest::Client::builder()
            .use_rustls_tls()
            .build()
            .map_err(|e| SyncError::Transport(e.to_string()))?;
        Ok(Self { client })
    }
}

impl HttpTransport for ReqwestTransport {
    async fn send(&self, req: HttpRequest) -> Result<HttpResponse, SyncError> {
        let method = reqwest::Method::from_bytes(req.method.as_bytes())
            .map_err(|e| SyncError::Transport(e.to_string()))?;
        let mut builder = self.client.request(method, &req.url);
        for (k, v) in &req.headers {
            builder = builder.header(k, v);
        }
        if let Some(body) = &req.body {
            builder = builder.json(body);
        }
        let resp = builder.send().await.map_err(|e| SyncError::Transport(e.to_string()))?;
        let status = resp.status().as_u16();
        let text = resp.text().await.map_err(|e| SyncError::Transport(e.to_string()))?;
        let body = if text.is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&text).unwrap_or(Value::Null)
        };
        Ok(HttpResponse { status, body })
    }
}

#[derive(Debug, Clone)]
pub struct EnrollResult {
    pub device_id: String,
    pub device_token: String,
    pub device_token_expires_at: String,
}

#[derive(Debug, Clone)]
pub struct SyncResult {
    pub accepted: u64,
    pub deduped: u64,
}

#[derive(Debug, Clone)]
pub struct SyncOutcome {
    pub uploaded: u64,
    pub deduped: u64,
    pub remaining: i64,
}

pub struct SyncClient<T: HttpTransport> {
    transport: T,
    base_url: String,
}

fn as_str(body: &Value, key: &str) -> Result<String, SyncError> {
    body.get(key)
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .ok_or_else(|| SyncError::Decode(format!("missing {key}")))
}

impl<T: HttpTransport> SyncClient<T> {
    pub fn new(transport: T, base_url: impl Into<String>) -> Self {
        Self { transport, base_url: base_url.into().trim_end_matches('/').to_string() }
    }

    /// Exchanges an authenticated USER session for a scoped device token.
    /// `user_headers` carries the user's auth (WorkOS Bearer, or dev identity
    /// headers locally). The returned device token is stored in the keychain by
    /// the caller and never returned to the webview.
    pub async fn enroll(
        &self,
        user_headers: Vec<(String, String)>,
        device: Value,
    ) -> Result<EnrollResult, SyncError> {
        let res = self
            .transport
            .send(HttpRequest {
                method: "POST",
                url: format!("{}/v1/devices/enroll", self.base_url),
                headers: user_headers,
                body: Some(device),
            })
            .await?;
        check_status(res.status)?;
        Ok(EnrollResult {
            device_id: as_str(&res.body, "device_id")?,
            device_token: as_str(&res.body, "device_token")?,
            device_token_expires_at: as_str(&res.body, "device_token_expires_at")?,
        })
    }

    /// Rotates the current device token, returning the replacement.
    pub async fn rotate(&self, device_token: &str) -> Result<EnrollResult, SyncError> {
        let res = self
            .transport
            .send(HttpRequest {
                method: "POST",
                url: format!("{}/v1/devices/rotate", self.base_url),
                headers: bearer(device_token),
                body: None,
            })
            .await?;
        check_status(res.status)?;
        Ok(EnrollResult {
            device_id: String::new(),
            device_token: as_str(&res.body, "device_token")?,
            device_token_expires_at: as_str(&res.body, "device_token_expires_at")?,
        })
    }

    /// Uploads a batch of redacted projections.
    pub async fn push_events(&self, device_token: &str, batch: Value) -> Result<SyncResult, SyncError> {
        let res = self
            .transport
            .send(HttpRequest {
                method: "POST",
                url: format!("{}/v1/sync/events", self.base_url),
                headers: bearer(device_token),
                body: Some(batch),
            })
            .await?;
        check_status(res.status)?;
        Ok(SyncResult {
            accepted: res.body.get("accepted").and_then(|v| v.as_u64()).unwrap_or(0),
            deduped: res.body.get("deduped").and_then(|v| v.as_u64()).unwrap_or(0),
        })
    }
}

fn bearer(token: &str) -> Vec<(String, String)> {
    vec![("authorization".to_string(), format!("Bearer {token}"))]
}

fn check_status(status: u16) -> Result<(), SyncError> {
    if status == 401 || status == 403 {
        return Err(SyncError::Unauthorized);
    }
    if !(200..300).contains(&status) {
        return Err(SyncError::Server(status));
    }
    Ok(())
}

/// Exponential backoff in seconds for a message that has failed `attempt` times.
/// 5s, 10s, 20s, … capped at 300s.
pub fn backoff_secs(attempt: i64) -> i64 {
    let capped_attempt = attempt.clamp(0, 6);
    (5_i64 * (1 << capped_attempt)).min(300)
}

/// Drains due event projections and uploads them in one batch. On success the
/// batch is acked (at-least-once → server dedupes); on failure it is deferred
/// with exponential backoff and stays queued. Returns what happened.
pub async fn drain_and_push<T: HttpTransport>(
    store: &LocalStore,
    client: &SyncClient<T>,
    device_token: &str,
    limit: i64,
) -> Result<SyncOutcome, SyncError> {
    let messages = store.outbox_drain(limit).await.map_err(|e| SyncError::Store(e.to_string()))?;
    let events: Vec<Value> = messages
        .iter()
        .filter(|m| m.message_type == "event")
        .map(|m| m.payload.clone())
        .collect();
    if events.is_empty() {
        let remaining = store.outbox_depth().await.map_err(|e| SyncError::Store(e.to_string()))?;
        return Ok(SyncOutcome { uploaded: 0, deduped: 0, remaining });
    }
    let ids: Vec<String> = messages
        .iter()
        .filter(|m| m.message_type == "event")
        .map(|m| m.outbox_id.clone())
        .collect();
    let max_attempt = messages.iter().map(|m| m.attempt_count).max().unwrap_or(0);
    let batch = json!({ "schema_version": 1, "events": events });

    match client.push_events(device_token, batch).await {
        Ok(result) => {
            store.outbox_ack(&ids).await.map_err(|e| SyncError::Store(e.to_string()))?;
            let remaining = store.outbox_depth().await.map_err(|e| SyncError::Store(e.to_string()))?;
            Ok(SyncOutcome { uploaded: result.accepted, deduped: result.deduped, remaining })
        }
        Err(err) => {
            store
                .outbox_defer(&ids, backoff_secs(max_attempt))
                .await
                .map_err(|e| SyncError::Store(e.to_string()))?;
            Err(err)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{LocalStore, StaticKeyProvider};
    use serde_json::json;
    use std::cell::RefCell;
    use tempfile::tempdir;

    /// Scripted transport: records requests, replies from a queue.
    struct MockTransport {
        replies: RefCell<Vec<(u16, Value)>>,
        seen: RefCell<Vec<HttpRequest>>,
    }
    impl MockTransport {
        fn new(replies: Vec<(u16, Value)>) -> Self {
            Self { replies: RefCell::new(replies), seen: RefCell::new(Vec::new()) }
        }
    }
    impl HttpTransport for MockTransport {
        async fn send(&self, req: HttpRequest) -> Result<HttpResponse, SyncError> {
            let (status, body) = self.replies.borrow_mut().remove(0);
            self.seen.borrow_mut().push(req);
            Ok(HttpResponse { status, body })
        }
    }

    fn sample_event(n: u32) -> Value {
        json!({
            "schema_version": 1,
            "event_id": format!("0191cccc-0000-7000-8000-0000000000{:02}", n),
            "occurred_at": "2026-07-18T10:00:00.000Z",
            "monotonic_ms": 1000,
            "source": "macos_ax",
            "app": { "display_name": "Salesforce", "domain": "acme.example.com" },
            "event_type": "record_update",
            "target": { "role": "row", "semantic_type": "save_button" },
            "context": { "object_type": "account" },
            "duration_ms": 1200,
            "sensitivity": "internal",
            "redaction": { "applied": false, "reasons": [] }
        })
    }

    async fn open_store() -> (LocalStore, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let store =
            LocalStore::open(&dir.path().join("s.sqlite"), &StaticKeyProvider([9u8; 32]), "u")
                .await
                .unwrap();
        // Return the TempDir so it outlives the store (dropping it deletes the db).
        (store, dir)
    }

    #[test]
    fn backoff_is_exponential_and_capped() {
        assert_eq!(backoff_secs(0), 5);
        assert_eq!(backoff_secs(1), 10);
        assert_eq!(backoff_secs(3), 40);
        assert_eq!(backoff_secs(100), 300); // capped
    }

    #[tokio::test]
    async fn enroll_parses_the_device_token() {
        let mock = MockTransport::new(vec![(
            200,
            json!({
                "device_id": "018f0000-0000-7000-8000-000000000001",
                "device_token": "d1.body.mac",
                "device_token_expires_at": "2026-08-18T10:00:00.000Z"
            }),
        )]);
        let client = SyncClient::new(mock, "http://localhost:4000/");
        let result = client.enroll(vec![], json!({})).await.unwrap();
        assert_eq!(result.device_token, "d1.body.mac");
    }

    #[tokio::test]
    async fn drain_and_push_uploads_then_acks() {
        let (store, _dir) = open_store().await;
        store.insert_event(&sample_event(1), 30).await.unwrap();
        store.insert_event(&sample_event(2), 30).await.unwrap();
        assert_eq!(store.outbox_depth().await.unwrap(), 2);

        let mock = MockTransport::new(vec![(200, json!({ "accepted": 2, "deduped": 0 }))]);
        let client = SyncClient::new(mock, "http://localhost:4000");
        let outcome = drain_and_push(&store, &client, "d1.tok", 100).await.unwrap();
        assert_eq!(outcome.uploaded, 2);
        // Acked → outbox drained to empty.
        assert_eq!(outcome.remaining, 0);
        assert_eq!(store.outbox_depth().await.unwrap(), 0);
        store.close().await;
    }

    #[tokio::test]
    async fn drain_and_push_sends_bearer_and_redacted_batch_only() {
        let (store, _dir) = open_store().await;
        store.insert_event(&sample_event(1), 30).await.unwrap();
        let mock = MockTransport::new(vec![(200, json!({ "accepted": 1, "deduped": 0 }))]);
        let client = SyncClient::new(mock, "http://localhost:4000");
        drain_and_push(&store, &client, "d1.SECRET_TOKEN", 100).await.unwrap();

        // The request carried the Bearer token and a redacted batch (no identity).
        let client_ref = &client;
        let seen = client_ref_seen(client_ref);
        assert_eq!(seen.0, "http://localhost:4000/v1/sync/events");
        assert!(seen.1.iter().any(|(k, v)| k == "authorization" && v == "Bearer d1.SECRET_TOKEN"));
        let serialized = seen.2.to_string();
        assert!(!serialized.contains("Salesforce"), "app name leaked in upload");
        assert!(!serialized.contains("acme.example.com"), "domain leaked in upload");
        store.close().await;
    }

    #[tokio::test]
    async fn drain_and_push_defers_on_server_error_and_keeps_queue() {
        let (store, _dir) = open_store().await;
        store.insert_event(&sample_event(1), 30).await.unwrap();
        let mock = MockTransport::new(vec![(503, Value::Null)]);
        let client = SyncClient::new(mock, "http://localhost:4000");
        let err = drain_and_push(&store, &client, "d1.tok", 100).await.unwrap_err();
        assert!(matches!(err, SyncError::Server(503)));
        // Still queued (at-least-once), but deferred out of the due window.
        assert_eq!(store.outbox_depth().await.unwrap(), 1);
        assert_eq!(store.outbox_drain(100).await.unwrap().len(), 0);
        store.close().await;
    }

    /// Helper to read the last recorded request from a mock-backed client.
    fn client_ref_seen(client: &SyncClient<MockTransport>) -> (String, Vec<(String, String)>, Value) {
        let seen = client.transport.seen.borrow();
        let last = seen.last().expect("a request was sent");
        (last.url.clone(), last.headers.clone(), last.body.clone().unwrap_or(Value::Null))
    }
}
