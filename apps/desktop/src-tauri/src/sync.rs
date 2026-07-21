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

    // ---- server-backed agent lifecycle (all bound to the device token) ----
    //
    // Every method below attaches the device token as a Bearer header and
    // returns the raw JSON response body. The webview never holds the token; it
    // receives only these non-secret projections (specs, diffs, receipts —
    // token material is guaranteed absent by the server's redaction invariants).

    /// Issues an authenticated GET/POST against the server with the device token.
    async fn authed(
        &self,
        method: &'static str,
        path: &str,
        device_token: &str,
        body: Option<Value>,
    ) -> Result<Value, SyncError> {
        let res = self
            .transport
            .send(HttpRequest {
                method,
                url: format!("{}{}", self.base_url, path),
                headers: bearer(device_token),
                body,
            })
            .await?;
        check_status(res.status)?;
        Ok(res.body)
    }

    /// Compiles an accepted PatternCandidate into an AgentSpec (server-side, so
    /// the configured model provider runs on the server, not the device).
    pub async fn compile_agent(&self, device_token: &str, body: Value) -> Result<Value, SyncError> {
        self.authed("POST", "/v1/agents/compile", device_token, Some(body)).await
    }

    /// Persists a compiled AgentSpec (agent + immutable version) server-side.
    pub async fn create_agent(&self, device_token: &str, body: Value) -> Result<Value, SyncError> {
        self.authed("POST", "/v1/agents", device_token, Some(body)).await
    }

    /// Starts a run (shadow/supervised) via the API→Temporal path.
    pub async fn start_run(
        &self,
        device_token: &str,
        agent_id: &str,
        body: Value,
    ) -> Result<Value, SyncError> {
        self.authed("POST", &format!("/v1/agents/{agent_id}/runs"), device_token, Some(body))
            .await
    }

    /// The run's current durable status.
    pub async fn run_status(&self, device_token: &str, run_id: &str) -> Result<Value, SyncError> {
        self.authed("GET", &format!("/v1/runs/{run_id}"), device_token, None).await
    }

    /// The pending approval (step id + diff hash), or null.
    pub async fn pending_approval(
        &self,
        device_token: &str,
        run_id: &str,
    ) -> Result<Value, SyncError> {
        self.authed("GET", &format!("/v1/runs/{run_id}/pending-approval"), device_token, None)
            .await
    }

    /// The proposed diff the run is waiting on (rendered exactly like local).
    pub async fn proposal(&self, device_token: &str, run_id: &str) -> Result<Value, SyncError> {
        self.authed("GET", &format!("/v1/runs/{run_id}/proposal"), device_token, None).await
    }

    /// The immutable ExecutionReceipt (null until the run finalizes).
    pub async fn receipt(&self, device_token: &str, run_id: &str) -> Result<Value, SyncError> {
        self.authed("GET", &format!("/v1/runs/{run_id}/receipt"), device_token, None).await
    }

    /// Approves a pending write (bound to step id + diff hash server-side).
    pub async fn approve_run(
        &self,
        device_token: &str,
        run_id: &str,
        body: Value,
    ) -> Result<Value, SyncError> {
        self.authed("POST", &format!("/v1/runs/{run_id}/approve"), device_token, Some(body)).await
    }

    /// Rejects a pending write.
    pub async fn reject_run(
        &self,
        device_token: &str,
        run_id: &str,
        body: Value,
    ) -> Result<Value, SyncError> {
        self.authed("POST", &format!("/v1/runs/{run_id}/reject"), device_token, Some(body)).await
    }

    // ---- dev identity resolution + connectors (webview never fetches HTTP) ----
    //
    // These originate here in Rust for the same reason as everything above: the
    // webview is forbidden (by CSP) from reaching the API directly. The resolve
    // endpoints are dev-only and unauthenticated; connector authorize carries a
    // principal (dev identity headers here).

    /// Resolves the seeded org UUID from its WorkOS id (dev-only endpoint).
    pub async fn resolve_org(&self, workos_id: &str) -> Result<Value, SyncError> {
        let res = self
            .transport
            .send(HttpRequest {
                method: "GET",
                url: format!("{}/v1/dev/resolve-org?workos_id={}", self.base_url, workos_id),
                headers: vec![],
                body: None,
            })
            .await?;
        check_status(res.status)?;
        Ok(res.body)
    }

    /// Resolves the seeded owner-user UUID from its WorkOS id (dev-only endpoint).
    pub async fn resolve_user(&self, workos_id: &str) -> Result<Value, SyncError> {
        let res = self
            .transport
            .send(HttpRequest {
                method: "GET",
                url: format!("{}/v1/dev/resolve-user?workos_id={}", self.base_url, workos_id),
                headers: vec![],
                body: None,
            })
            .await?;
        check_status(res.status)?;
        Ok(res.body)
    }

    /// Requests an OAuth authorization URL for a connector. The caller supplies
    /// the principal headers (dev identity or device token); the URL is opened in
    /// the system browser by the desktop — tokens never touch the webview.
    pub async fn connector_authorize(
        &self,
        headers: Vec<(String, String)>,
        provider: &str,
    ) -> Result<Value, SyncError> {
        let res = self
            .transport
            .send(HttpRequest {
                method: "POST",
                url: format!("{}/v1/connectors/{}/authorize", self.base_url, provider),
                headers,
                body: None,
            })
            .await?;
        check_status(res.status)?;
        Ok(res.body)
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
    async fn server_agent_calls_attach_bearer_and_hit_the_right_paths() {
        // compile → create → start_run → pending → proposal → approve → receipt.
        let mock = MockTransport::new(vec![
            (200, json!({ "spec": {}, "model_cost_usd": 0 })),
            (200, json!({ "agent_id": "a1", "agent_version_id": "v1" })),
            (200, json!({ "run_id": "r1", "workflow_id": "run-r1", "duplicate": false })),
            (200, json!({ "pending": { "step_id": "s1", "diff_sha256": "abc" } })),
            (200, json!({ "diff": { "summary": { "change_count": 4 } } })),
            (200, json!({ "approved": true })),
            (200, json!({ "receipt": { "run_id": "r1" } })),
        ]);
        let client = SyncClient::new(mock, "http://localhost:4000");
        let tok = "d1.DEVICE_TOKEN";

        client.compile_agent(tok, json!({ "candidate": {} })).await.unwrap();
        client.create_agent(tok, json!({ "spec": {} })).await.unwrap();
        let run = client
            .start_run(tok, "a1", json!({ "mode": "supervised", "trigger_idempotency_key": "k" }))
            .await
            .unwrap();
        assert_eq!(run.get("run_id").unwrap(), "r1");
        let pending = client.pending_approval(tok, "r1").await.unwrap();
        assert_eq!(pending.pointer("/pending/diff_sha256").unwrap(), "abc");
        let proposal = client.proposal(tok, "r1").await.unwrap();
        assert_eq!(proposal.pointer("/diff/summary/change_count").unwrap(), 4);
        client
            .approve_run(tok, "r1", json!({ "step_id": "s1", "diff_hash": "abc" }))
            .await
            .unwrap();
        client.receipt(tok, "r1").await.unwrap();

        // Every request carried the device token as a Bearer header, and the
        // right paths were hit in order.
        let seen = client.transport.seen.borrow();
        assert!(seen
            .iter()
            .all(|r| r.headers.iter().any(|(k, v)| k == "authorization" && v == "Bearer d1.DEVICE_TOKEN")));
        let paths: Vec<&str> = seen.iter().map(|r| r.url.as_str()).collect();
        assert_eq!(paths[0], "http://localhost:4000/v1/agents/compile");
        assert_eq!(paths[1], "http://localhost:4000/v1/agents");
        assert_eq!(paths[2], "http://localhost:4000/v1/agents/a1/runs");
        assert_eq!(paths[3], "http://localhost:4000/v1/runs/r1/pending-approval");
        assert_eq!(paths[4], "http://localhost:4000/v1/runs/r1/proposal");
        assert_eq!(paths[5], "http://localhost:4000/v1/runs/r1/approve");
        assert_eq!(paths[6], "http://localhost:4000/v1/runs/r1/receipt");
    }

    #[tokio::test]
    async fn resolve_org_and_user_parse_and_hit_dev_endpoints() {
        let mock = MockTransport::new(vec![
            (200, json!({ "organization_id": "org-uuid" })),
            (200, json!({ "user_id": "user-uuid", "role": "member" })),
        ]);
        let client = SyncClient::new(mock, "http://localhost:4000");
        let org = client.resolve_org("org_demo_acme_sales").await.unwrap();
        assert_eq!(org.get("organization_id").unwrap(), "org-uuid");
        let user = client.resolve_user("user_demo_alex").await.unwrap();
        assert_eq!(user.get("user_id").unwrap(), "user-uuid");
        let seen = client.transport.seen.borrow();
        assert_eq!(seen[0].url, "http://localhost:4000/v1/dev/resolve-org?workos_id=org_demo_acme_sales");
        assert_eq!(seen[1].url, "http://localhost:4000/v1/dev/resolve-user?workos_id=user_demo_alex");
        // No auth headers on the dev-only resolve endpoints.
        assert!(seen[0].headers.is_empty());
    }

    #[tokio::test]
    async fn resolve_org_maps_404_to_server_error() {
        let mock = MockTransport::new(vec![(404, Value::Null)]);
        let client = SyncClient::new(mock, "http://localhost:4000");
        let err = client.resolve_org("nope").await.unwrap_err();
        assert!(matches!(err, SyncError::Server(404)));
    }

    #[tokio::test]
    async fn resolve_user_maps_404_to_server_error() {
        let mock = MockTransport::new(vec![(404, Value::Null)]);
        let client = SyncClient::new(mock, "http://localhost:4000");
        let err = client.resolve_user("nope").await.unwrap_err();
        assert!(matches!(err, SyncError::Server(404)));
    }

    #[tokio::test]
    async fn resolve_org_propagates_transport_error() {
        struct DeadTransport;
        impl HttpTransport for DeadTransport {
            async fn send(&self, _req: HttpRequest) -> Result<HttpResponse, SyncError> {
                Err(SyncError::Transport("connection refused".into()))
            }
        }
        let client = SyncClient::new(DeadTransport, "http://localhost:4000");
        let err = client.resolve_org("x").await.unwrap_err();
        assert!(matches!(err, SyncError::Transport(_)));
    }

    #[tokio::test]
    async fn connector_authorize_carries_principal_headers_and_returns_url() {
        let mock = MockTransport::new(vec![(
            200,
            json!({ "authorization_url": "https://login.salesforce.com/oauth", "expires_in_seconds": 600 }),
        )]);
        let client = SyncClient::new(mock, "http://localhost:4000");
        let headers = vec![
            ("x-dev-org-id".to_string(), "org-uuid".to_string()),
            ("x-dev-user-id".to_string(), "user-uuid".to_string()),
            ("x-dev-role".to_string(), "member".to_string()),
        ];
        let res = client.connector_authorize(headers, "salesforce").await.unwrap();
        assert_eq!(res.get("authorization_url").unwrap(), "https://login.salesforce.com/oauth");
        let seen = client.transport.seen.borrow();
        assert_eq!(seen[0].url, "http://localhost:4000/v1/connectors/salesforce/authorize");
        assert!(seen[0].headers.iter().any(|(k, v)| k == "x-dev-org-id" && v == "org-uuid"));
    }

    #[tokio::test]
    async fn server_agent_call_maps_401_to_unauthorized() {
        let mock = MockTransport::new(vec![(401, Value::Null)]);
        let client = SyncClient::new(mock, "http://localhost:4000");
        let err = client.run_status("d1.tok", "r1").await.unwrap_err();
        assert!(matches!(err, SyncError::Unauthorized));
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
