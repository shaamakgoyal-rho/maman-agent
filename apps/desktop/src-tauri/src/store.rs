//! Local encrypted event store.
//!
//! - SQLite via sqlx under the app data directory.
//! - Sensitive payload columns are AES-256-GCM encrypted with a random 256-bit
//!   device key held in the macOS Keychain (never on disk).
//! - Every record uses a fresh random nonce; associated authenticated data
//!   binds table name, record id, schema version, and owner user id, so a
//!   ciphertext moved between rows or tables fails authentication.
//! - Decryption failure quarantines the row (never crashes the pipeline).
//! - Serialization, validation, encryption, and hashing all live here.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use hmac::{Hmac, Mac};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};
use std::path::Path;
use std::str::FromStr;

pub const EVENT_RETENTION_DAYS_DEFAULT: i64 = 30;
pub const EPISODE_RETENTION_DAYS_DEFAULT: i64 = 90;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),
    #[error("crypto failure for {context}")]
    Crypto { context: String },
    #[error("invalid payload: {0}")]
    InvalidPayload(String),
    #[error("forbidden field present: {0}")]
    ForbiddenField(String),
    #[error("key provider failure: {0}")]
    Key(String),
}

/// Abstracts key acquisition so tests never touch the real Keychain.
pub trait KeyProvider: Send + Sync {
    fn get_or_create_key(&self) -> Result<[u8; 32], StoreError>;
}

/// Production: random 256-bit key stored in the macOS Keychain via `keyring`.
pub struct KeychainKeyProvider {
    pub service: String,
    pub account: String,
}

impl KeyProvider for KeychainKeyProvider {
    fn get_or_create_key(&self) -> Result<[u8; 32], StoreError> {
        let entry = keyring::Entry::new(&self.service, &self.account)
            .map_err(|e| StoreError::Key(e.to_string()))?;
        match entry.get_password() {
            Ok(hex_key) => {
                let bytes = hex::decode(hex_key).map_err(|e| StoreError::Key(e.to_string()))?;
                bytes
                    .try_into()
                    .map_err(|_| StoreError::Key("stored key has wrong length".into()))
            }
            Err(keyring::Error::NoEntry) => {
                let mut key = [0u8; 32];
                rand::thread_rng().fill_bytes(&mut key);
                entry
                    .set_password(&hex::encode(key))
                    .map_err(|e| StoreError::Key(e.to_string()))?;
                Ok(key)
            }
            Err(e) => Err(StoreError::Key(e.to_string())),
        }
    }
}

/// Tests / ephemeral contexts: fixed in-memory key.
pub struct StaticKeyProvider(pub [u8; 32]);
impl KeyProvider for StaticKeyProvider {
    fn get_or_create_key(&self) -> Result<[u8; 32], StoreError> {
        Ok(self.0)
    }
}

/// Deletes the device key (used by "Delete this device's data").
pub fn delete_keychain_key(service: &str, account: &str) {
    if let Ok(entry) = keyring::Entry::new(service, account) {
        let _ = entry.delete_credential();
    }
}

/// Stores an opaque secret (e.g. the device token) in the OS keychain. The
/// device token never touches the webview or JS — only the Rust core reads it.
pub fn store_keychain_secret(service: &str, account: &str, value: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(service, account).map_err(|e| e.to_string())?;
    entry.set_password(value).map_err(|e| e.to_string())
}

/// Loads a keychain secret, or None when unset.
pub fn load_keychain_secret(service: &str, account: &str) -> Option<String> {
    let entry = keyring::Entry::new(service, account).ok()?;
    entry.get_password().ok()
}

/// One decrypted outbox message awaiting upload.
#[derive(Debug, Clone)]
pub struct OutboxMessage {
    pub outbox_id: String,
    pub message_type: String,
    pub payload: serde_json::Value,
    pub attempt_count: i64,
}

const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS local_settings (
  key TEXT PRIMARY KEY,
  encrypted_value BLOB NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_events (
  event_id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  source TEXT NOT NULL,
  app_category TEXT NOT NULL,
  app_hmac TEXT NOT NULL,
  event_type TEXT NOT NULL,
  sensitivity TEXT NOT NULL,
  encrypted_payload BLOB NOT NULL,
  payload_sha256 TEXT NOT NULL,
  excluded_from_learning INTEGER NOT NULL DEFAULT 0,
  quarantined INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_occurred ON workflow_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_expiry ON workflow_events (expires_at);
CREATE TABLE IF NOT EXISTS workflow_episodes (
  episode_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  active_duration_ms INTEGER NOT NULL,
  encrypted_payload BLOB NOT NULL,
  payload_sha256 TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pattern_candidates (
  pattern_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  opportunity_score REAL NOT NULL,
  encrypted_payload BLOB NOT NULL,
  payload_sha256 TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  suppressed_until TEXT
);
CREATE TABLE IF NOT EXISTS suggestion_history (
  recommendation_local_id TEXT PRIMARY KEY,
  pattern_id TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT,
  occurred_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_outbox (
  outbox_id TEXT PRIMARY KEY,
  message_type TEXT NOT NULL,
  encrypted_payload BLOB NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- Local-only linkage so deletion removes queued projections. Never uploaded:
  -- ref_event_id ties a queued projection to its source event; app_hmac is the
  -- same de-identified keyed HMAC used for per-app deletion.
  ref_event_id TEXT,
  app_hmac TEXT
);
CREATE TABLE IF NOT EXISTS deletion_tombstones (
  tombstone_id TEXT PRIMARY KEY,
  resource_type TEXT NOT NULL,
  resource_id_hash TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  sync_status TEXT NOT NULL
);
"#;

pub struct LocalStore {
    pool: SqlitePool,
    key: [u8; 32],
    owner_user_id: String,
}

/// Minimal decrypted projection for the "What Maman saw" timeline.
#[derive(Debug, Serialize, Deserialize)]
pub struct TimelineEntry {
    pub event_id: String,
    pub occurred_at: String,
    pub source: String,
    pub app_category: String,
    pub event_type: String,
    pub sensitivity: String,
    pub app_display_name: String,
    pub semantic_type: Option<String>,
    pub object_type: Option<String>,
    pub duration_ms: Option<i64>,
    pub excluded_from_learning: bool,
}

fn unix_ms_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn now_iso() -> String {
    // RFC3339 UTC without external chrono dependency.
    iso_from_unix_ms(unix_ms_now())
}

pub fn iso_from_unix_ms(ms: i64) -> String {
    // Days-from-civil algorithm (Howard Hinnant) — deterministic, no deps.
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400);
    let (h, m, s) = (tod / 3600, (tod % 3600) / 60, tod % 60);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}.{millis:03}Z")
}

fn iso_days_from_now(days: i64) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    iso_from_unix_ms(now.as_millis() as i64 + days * 86_400_000)
}

impl LocalStore {
    pub async fn open(
        db_path: &Path,
        key_provider: &dyn KeyProvider,
        owner_user_id: &str,
    ) -> Result<Self, StoreError> {
        let key = key_provider.get_or_create_key()?;
        let options = SqliteConnectOptions::from_str(&format!("sqlite://{}", db_path.display()))
            .map_err(StoreError::Db)?
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(options)
            .await?;
        sqlx::raw_sql(SCHEMA_SQL).execute(&pool).await?;
        Ok(Self {
            pool,
            key,
            owner_user_id: owner_user_id.to_string(),
        })
    }

    // ---- crypto ----

    fn aad(&self, table: &str, record_id: &str, schema_version: u32) -> Vec<u8> {
        format!("{table}:{record_id}:{schema_version}:{}", self.owner_user_id).into_bytes()
    }

    fn encrypt(&self, plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>, StoreError> {
        let cipher = Aes256Gcm::new_from_slice(&self.key)
            .map_err(|_| StoreError::Crypto { context: "key".into() })?;
        // Never reuse a nonce: 96-bit random per record.
        let mut nonce_bytes = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);
        let ciphertext = cipher
            .encrypt(nonce, Payload { msg: plaintext, aad })
            .map_err(|_| StoreError::Crypto { context: "encrypt".into() })?;
        let mut out = nonce_bytes.to_vec();
        out.extend_from_slice(&ciphertext);
        Ok(out)
    }

    fn decrypt(&self, blob: &[u8], aad: &[u8]) -> Result<Vec<u8>, StoreError> {
        if blob.len() < 13 {
            return Err(StoreError::Crypto { context: "blob too short".into() });
        }
        let cipher = Aes256Gcm::new_from_slice(&self.key)
            .map_err(|_| StoreError::Crypto { context: "key".into() })?;
        let (nonce_bytes, ciphertext) = blob.split_at(12);
        cipher
            .decrypt(Nonce::from_slice(nonce_bytes), Payload { msg: ciphertext, aad })
            .map_err(|_| StoreError::Crypto { context: "decrypt".into() })
    }

    fn app_hmac(&self, identity: &str) -> String {
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&self.key).expect("hmac accepts any key len");
        mac.update(identity.to_lowercase().as_bytes());
        hex::encode(&mac.finalize().into_bytes()[..16])
    }

    // ---- events ----

    /// Validates, redaction-checks, encrypts, and persists one WorkflowEvent
    /// (given as its JSON value). Returns the event_id.
    pub async fn insert_event(
        &self,
        event: &serde_json::Value,
        retention_days: i64,
    ) -> Result<String, StoreError> {
        if let Some(field) = crate::redaction::find_forbidden_field(event) {
            return Err(StoreError::ForbiddenField(field));
        }
        let get = |path: &[&str]| -> Option<&serde_json::Value> {
            let mut cur = event;
            for p in path {
                cur = cur.get(p)?;
            }
            Some(cur)
        };
        let str_at = |path: &[&str]| -> Result<String, StoreError> {
            get(path)
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .ok_or_else(|| StoreError::InvalidPayload(format!("missing {}", path.join("."))))
        };

        let event_id = str_at(&["event_id"])?;
        let occurred_at = str_at(&["occurred_at"])?;
        let source = str_at(&["source"])?;
        let event_type = str_at(&["event_type"])?;
        let sensitivity = str_at(&["sensitivity"])?;
        let display_name = str_at(&["app", "display_name"])?;
        let schema_version = get(&["schema_version"]).and_then(|v| v.as_u64()).unwrap_or(1) as u32;

        let app_category = categorize_app(
            &display_name,
            get(&["app", "domain"]).and_then(|v| v.as_str()),
        );

        let plaintext = serde_json::to_vec(event)
            .map_err(|e| StoreError::InvalidPayload(e.to_string()))?;
        let payload_sha256 = hex::encode(Sha256::digest(&plaintext));
        let aad = self.aad("workflow_events", &event_id, schema_version);
        let encrypted = self.encrypt(&plaintext, &aad)?;
        let app_hmac = self.app_hmac(&display_name);
        let expires_at = iso_days_from_now(retention_days);

        sqlx::query(
            "INSERT OR REPLACE INTO workflow_events
             (event_id, occurred_at, source, app_category, app_hmac, event_type, sensitivity,
              encrypted_payload, payload_sha256, excluded_from_learning, quarantined, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)",
        )
        .bind(&event_id)
        .bind(&occurred_at)
        .bind(&source)
        .bind(&app_category)
        .bind(&app_hmac)
        .bind(&event_type)
        .bind(&sensitivity)
        .bind(&encrypted)
        .bind(&payload_sha256)
        .bind(&expires_at)
        .execute(&self.pool)
        .await?;

        // Enqueue the redacted, identity-safe projection for upload. This is the
        // ONLY shape that leaves the device; the raw event stays encrypted here.
        // Linked to event_id + app_hmac so deletion removes the queued projection.
        let projection = redacted_projection(event, &app_category);
        self.outbox_enqueue_event(&event_id, &app_hmac, &projection).await?;

        Ok(event_id)
    }

    /// Human-readable timeline. Rows that fail decryption are quarantined and
    /// surfaced as a recoverable local-store error entry, never a crash.
    pub async fn timeline(&self, limit: i64, offset: i64) -> Result<Vec<TimelineEntry>, StoreError> {
        let rows = sqlx::query(
            "SELECT event_id, occurred_at, source, app_category, event_type, sensitivity,
                    encrypted_payload, excluded_from_learning, quarantined
             FROM workflow_events
             ORDER BY occurred_at DESC LIMIT ? OFFSET ?",
        )
        .bind(limit)
        .bind(offset)
        .fetch_all(&self.pool)
        .await?;

        let mut entries = Vec::with_capacity(rows.len());
        for row in rows {
            let event_id: String = row.get("event_id");
            let quarantined: i64 = row.get("quarantined");
            if quarantined != 0 {
                continue;
            }
            let blob: Vec<u8> = row.get("encrypted_payload");
            let aad = self.aad("workflow_events", &event_id, 1);
            match self
                .decrypt(&blob, &aad)
                .ok()
                .and_then(|pt| serde_json::from_slice::<serde_json::Value>(&pt).ok())
            {
                Some(payload) => {
                    entries.push(TimelineEntry {
                        event_id: event_id.clone(),
                        occurred_at: row.get("occurred_at"),
                        source: row.get("source"),
                        app_category: row.get("app_category"),
                        event_type: row.get("event_type"),
                        sensitivity: row.get("sensitivity"),
                        app_display_name: payload
                            .pointer("/app/display_name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("Unknown")
                            .to_string(),
                        semantic_type: payload
                            .pointer("/target/semantic_type")
                            .and_then(|v| v.as_str())
                            .map(str::to_string),
                        object_type: payload
                            .pointer("/context/object_type")
                            .and_then(|v| v.as_str())
                            .map(str::to_string),
                        duration_ms: payload.get("duration_ms").and_then(|v| v.as_i64()),
                        excluded_from_learning: row.get::<i64, _>("excluded_from_learning") != 0,
                    });
                }
                None => {
                    // Quarantine: log only the record id and error class.
                    eprintln!("store: quarantining undecryptable event {event_id}");
                    sqlx::query("UPDATE workflow_events SET quarantined = 1 WHERE event_id = ?")
                        .bind(&event_id)
                        .execute(&self.pool)
                        .await?;
                }
            }
        }
        Ok(entries)
    }

    /// PatternFeatureEvent projection for the pattern engine (spec §9):
    /// excludes bundle ids, domains, record hashes, field names, labels, and
    /// encrypted payloads. This is the ONLY bulk read the webview may perform.
    pub async fn pattern_features(&self, limit: i64) -> Result<Vec<serde_json::Value>, StoreError> {
        let rows = sqlx::query(
            "SELECT event_id, occurred_at, source, app_category, event_type, sensitivity,
                    encrypted_payload, excluded_from_learning, quarantined
             FROM workflow_events
             ORDER BY occurred_at ASC LIMIT ?",
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;

        let mut features = Vec::with_capacity(rows.len());
        for row in rows {
            let quarantined: i64 = row.get("quarantined");
            if quarantined != 0 {
                continue;
            }
            let event_id: String = row.get("event_id");
            let blob: Vec<u8> = row.get("encrypted_payload");
            let aad = self.aad("workflow_events", &event_id, 1);
            let Some(payload) = self
                .decrypt(&blob, &aad)
                .ok()
                .and_then(|pt| serde_json::from_slice::<serde_json::Value>(&pt).ok())
            else {
                continue;
            };
            let item_count = payload.pointer("/context/item_count").and_then(|v| v.as_i64());
            let bucket = item_count.map(|n| match n {
                i64::MIN..=1 => "1",
                2..=10 => "2_10",
                11..=50 => "11_50",
                51..=200 => "51_200",
                _ => "201_plus",
            });
            let mut feature = serde_json::json!({
                "event_id": event_id,
                "occurred_at": row.get::<String, _>("occurred_at"),
                "monotonic_ms": payload.get("monotonic_ms").and_then(|v| v.as_i64()).unwrap_or(0),
                "source": row.get::<String, _>("source"),
                "app_category": row.get::<String, _>("app_category"),
                "event_type": row.get::<String, _>("event_type"),
                "sensitivity": row.get::<String, _>("sensitivity"),
                "excluded_from_learning": row.get::<i64, _>("excluded_from_learning") != 0,
            });
            if let Some(role) = payload.pointer("/target/role").and_then(|v| v.as_str()) {
                feature["target_role"] = serde_json::json!(role);
            }
            if let Some(sem) = payload.pointer("/target/semantic_type").and_then(|v| v.as_str()) {
                feature["semantic_type"] = serde_json::json!(sem);
            }
            if let Some(obj) = payload.pointer("/context/object_type").and_then(|v| v.as_str()) {
                feature["object_type"] = serde_json::json!(obj);
            }
            if let Some(d) = payload.get("duration_ms").and_then(|v| v.as_i64()) {
                feature["duration_ms"] = serde_json::json!(d);
            }
            if let Some(b) = bucket {
                feature["item_count_bucket"] = serde_json::json!(b);
            }
            features.push(feature);
        }
        Ok(features)
    }

    pub async fn count_events(&self) -> Result<i64, StoreError> {
        let row = sqlx::query("SELECT COUNT(*) AS n FROM workflow_events")
            .fetch_one(&self.pool)
            .await?;
        Ok(row.get::<i64, _>("n"))
    }

    async fn tombstone(&self, resource_type: &str, resource_id: &str) -> Result<(), StoreError> {
        let hash = hex::encode(&Sha256::digest(resource_id.as_bytes())[..16]);
        sqlx::query(
            "INSERT INTO deletion_tombstones (tombstone_id, resource_type, resource_id_hash, deleted_at, sync_status)
             VALUES (?, ?, ?, ?, 'pending')",
        )
        .bind(format!("ts-{hash}-{}", now_iso()))
        .bind(resource_type)
        .bind(hash)
        .bind(now_iso())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn delete_event(&self, event_id: &str) -> Result<bool, StoreError> {
        let result = sqlx::query("DELETE FROM workflow_events WHERE event_id = ?")
            .bind(event_id)
            .execute(&self.pool)
            .await?;
        if result.rows_affected() > 0 {
            self.tombstone("workflow_event", event_id).await?;
            // The queued redacted projection is removed with the event so a
            // deleted event can never sync afterward.
            sqlx::query("DELETE FROM sync_outbox WHERE ref_event_id = ?")
                .bind(event_id)
                .execute(&self.pool)
                .await?;
        }
        Ok(result.rows_affected() > 0)
    }

    /// Deletes every event for one application (matched by keyed app HMAC).
    pub async fn delete_app_history(&self, display_name: &str) -> Result<u64, StoreError> {
        let hmac = self.app_hmac(display_name);
        let result = sqlx::query("DELETE FROM workflow_events WHERE app_hmac = ?")
            .bind(&hmac)
            .execute(&self.pool)
            .await?;
        if result.rows_affected() > 0 {
            self.tombstone("app_history", &hmac).await?;
            // Purge queued projections for this app so they never sync.
            sqlx::query("DELETE FROM sync_outbox WHERE app_hmac = ?")
                .bind(&hmac)
                .execute(&self.pool)
                .await?;
        }
        Ok(result.rows_affected())
    }

    pub async fn delete_all_events(&self) -> Result<u64, StoreError> {
        let result = sqlx::query("DELETE FROM workflow_events").execute(&self.pool).await?;
        sqlx::query("DELETE FROM workflow_episodes").execute(&self.pool).await?;
        sqlx::query("DELETE FROM sync_outbox WHERE message_type = 'event'")
            .execute(&self.pool)
            .await?;
        self.tombstone("all_events", "all").await?;
        Ok(result.rows_affected())
    }

    pub async fn set_excluded_from_learning(
        &self,
        event_id: &str,
        excluded: bool,
    ) -> Result<bool, StoreError> {
        let result =
            sqlx::query("UPDATE workflow_events SET excluded_from_learning = ? WHERE event_id = ?")
                .bind(if excluded { 1 } else { 0 })
                .bind(event_id)
                .execute(&self.pool)
                .await?;
        Ok(result.rows_affected() > 0)
    }

    /// Retention sweep: removes expired events/episodes. Tombstones are never
    /// deleted by retention (they must outlive the data they mark).
    pub async fn sweep_retention(&self) -> Result<u64, StoreError> {
        let now = now_iso();
        let a = sqlx::query("DELETE FROM workflow_events WHERE expires_at < ?")
            .bind(&now)
            .execute(&self.pool)
            .await?;
        let b = sqlx::query("DELETE FROM workflow_episodes WHERE expires_at < ?")
            .bind(&now)
            .execute(&self.pool)
            .await?;
        Ok(a.rows_affected() + b.rows_affected())
    }

    // ---- outbox ----

    pub async fn outbox_enqueue(
        &self,
        message_type: &str,
        payload: &serde_json::Value,
    ) -> Result<String, StoreError> {
        let id = format!("ob-{}", hex::encode(&Sha256::digest(payload.to_string().as_bytes())[..12]));
        let plaintext = serde_json::to_vec(payload)
            .map_err(|e| StoreError::InvalidPayload(e.to_string()))?;
        let aad = self.aad("sync_outbox", &id, 1);
        let encrypted = self.encrypt(&plaintext, &aad)?;
        sqlx::query(
            "INSERT OR IGNORE INTO sync_outbox (outbox_id, message_type, encrypted_payload, attempt_count, available_at, created_at)
             VALUES (?, ?, ?, 0, ?, ?)",
        )
        .bind(&id)
        .bind(message_type)
        .bind(&encrypted)
        .bind(now_iso())
        .bind(now_iso())
        .execute(&self.pool)
        .await?;
        Ok(id)
    }

    /// Enqueues an event projection with local deletion linkage. The outbox id is
    /// derived from the event id so re-inserting the same event does not duplicate
    /// the queued projection, and deletion can target it precisely.
    pub async fn outbox_enqueue_event(
        &self,
        event_id: &str,
        app_hmac: &str,
        payload: &serde_json::Value,
    ) -> Result<String, StoreError> {
        let id = format!("ob-evt-{event_id}");
        let plaintext = serde_json::to_vec(payload)
            .map_err(|e| StoreError::InvalidPayload(e.to_string()))?;
        let aad = self.aad("sync_outbox", &id, 1);
        let encrypted = self.encrypt(&plaintext, &aad)?;
        sqlx::query(
            "INSERT OR IGNORE INTO sync_outbox
             (outbox_id, message_type, encrypted_payload, attempt_count, available_at, created_at, ref_event_id, app_hmac)
             VALUES (?, 'event', ?, 0, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(&encrypted)
        .bind(now_iso())
        .bind(now_iso())
        .bind(event_id)
        .bind(app_hmac)
        .execute(&self.pool)
        .await?;
        Ok(id)
    }

    pub async fn outbox_depth(&self) -> Result<i64, StoreError> {
        let row = sqlx::query("SELECT COUNT(*) AS n FROM sync_outbox")
            .fetch_one(&self.pool)
            .await?;
        Ok(row.get::<i64, _>("n"))
    }

    /// Drains up to `limit` due outbox messages (available_at <= now), decrypting
    /// each payload. Rows whose payload fails to decrypt are skipped (never
    /// surfaced as plaintext).
    pub async fn outbox_drain(&self, limit: i64) -> Result<Vec<OutboxMessage>, StoreError> {
        let rows = sqlx::query(
            "SELECT outbox_id, message_type, encrypted_payload, attempt_count FROM sync_outbox
             WHERE available_at <= ? ORDER BY created_at ASC LIMIT ?",
        )
        .bind(now_iso())
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            let id: String = row.get("outbox_id");
            let message_type: String = row.get("message_type");
            let attempt_count: i64 = row.get("attempt_count");
            let blob: Vec<u8> = row.get("encrypted_payload");
            let aad = self.aad("sync_outbox", &id, 1);
            if let Some(payload) = self
                .decrypt(&blob, &aad)
                .ok()
                .and_then(|pt| serde_json::from_slice::<serde_json::Value>(&pt).ok())
            {
                out.push(OutboxMessage { outbox_id: id, message_type, payload, attempt_count });
            }
        }
        Ok(out)
    }

    /// Acknowledges (deletes) delivered messages. At-least-once: we only delete
    /// after the server has accepted the batch.
    pub async fn outbox_ack(&self, ids: &[String]) -> Result<u64, StoreError> {
        let mut total = 0;
        for id in ids {
            let res = sqlx::query("DELETE FROM sync_outbox WHERE outbox_id = ?")
                .bind(id)
                .execute(&self.pool)
                .await?;
            total += res.rows_affected();
        }
        Ok(total)
    }

    /// Defers messages after a failed delivery: increments attempt_count and
    /// pushes availability out by `backoff_secs` (caller computes exponential).
    pub async fn outbox_defer(&self, ids: &[String], backoff_secs: i64) -> Result<(), StoreError> {
        let available = iso_from_unix_ms(unix_ms_now() + backoff_secs * 1000);
        for id in ids {
            sqlx::query(
                "UPDATE sync_outbox SET attempt_count = attempt_count + 1, available_at = ? WHERE outbox_id = ?",
            )
            .bind(&available)
            .bind(id)
            .execute(&self.pool)
            .await?;
        }
        Ok(())
    }

    pub async fn tombstone_count(&self) -> Result<i64, StoreError> {
        let row = sqlx::query("SELECT COUNT(*) AS n FROM deletion_tombstones")
            .fetch_one(&self.pool)
            .await?;
        Ok(row.get::<i64, _>("n"))
    }

    pub async fn close(&self) {
        self.pool.close().await;
    }
}

/// Builds the redacted, identity-safe projection uploaded to the server. It
/// carries coarse category, semantic tags, and bucketed counts only — never an
/// app display name, domain, URL, raw payload, or typed value. Mirrors the
/// `syncEventProjectionSchema` contract exactly (strict on the server).
pub fn redacted_projection(event: &serde_json::Value, app_category: &str) -> serde_json::Value {
    let get = |path: &[&str]| -> Option<&serde_json::Value> {
        let mut cur = event;
        for p in path {
            cur = cur.get(p)?;
        }
        Some(cur)
    };
    let item_count = get(&["context", "item_count"]).and_then(|v| v.as_i64());
    let bucket = item_count.map(|n| match n {
        i64::MIN..=1 => "1",
        2..=10 => "2_10",
        11..=50 => "11_50",
        51..=200 => "51_200",
        _ => "201_plus",
    });
    let mut projection = serde_json::json!({
        "schema_version": 1,
        "event_id": get(&["event_id"]).and_then(|v| v.as_str()).unwrap_or_default(),
        "occurred_at": get(&["occurred_at"]).and_then(|v| v.as_str()).unwrap_or_default(),
        "monotonic_ms": get(&["monotonic_ms"]).and_then(|v| v.as_i64()).unwrap_or(0).max(0),
        "source": get(&["source"]).and_then(|v| v.as_str()).unwrap_or_default(),
        "app_category": app_category,
        "event_type": get(&["event_type"]).and_then(|v| v.as_str()).unwrap_or_default(),
        "sensitivity": get(&["sensitivity"]).and_then(|v| v.as_str()).unwrap_or_default(),
        "excluded_from_learning": false,
    });
    if let Some(v) = get(&["target", "role"]).and_then(|v| v.as_str()) {
        projection["target_role"] = serde_json::json!(v);
    }
    if let Some(v) = get(&["target", "semantic_type"]).and_then(|v| v.as_str()) {
        projection["semantic_type"] = serde_json::json!(v);
    }
    if let Some(v) = get(&["context", "object_type"]).and_then(|v| v.as_str()) {
        projection["object_type"] = serde_json::json!(v);
    }
    if let Some(v) = get(&["duration_ms"]).and_then(|v| v.as_i64()) {
        if v >= 0 {
            projection["duration_ms"] = serde_json::json!(v);
        }
    }
    if let Some(b) = bucket {
        projection["item_count_bucket"] = serde_json::json!(b);
    }
    projection
}

/// Maps app identity to the coarse category exposed to the pattern engine.
pub fn categorize_app(display_name: &str, domain: Option<&str>) -> String {
    let hay = format!("{} {}", display_name.to_lowercase(), domain.unwrap_or("").to_lowercase());
    if hay.contains("salesforce") || hay.contains("force.com") || hay.contains("hubspot") {
        "crm"
    } else if hay.contains("sheets") || hay.contains("excel") || hay.contains("airtable") {
        "spreadsheet"
    } else if hay.contains("gmail") || hay.contains("mail") || hay.contains("outlook") {
        "email"
    } else if hay.contains("calendar") {
        "calendar"
    } else if hay.contains("linkedin") || hay.contains("apollo") || hay.contains("zoominfo") {
        "research"
    } else if hay.contains("chrome") || domain.is_some() {
        "browser"
    } else {
        "other"
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    const TEST_KEY: [u8; 32] = [7u8; 32];
    const MARKER: &str = "SENSITIVE_FIXTURE_MARKER_ZX81";

    fn sample_event(id_suffix: u32) -> serde_json::Value {
        json!({
            "schema_version": 1,
            "event_id": format!("0191aaaa-0000-7000-8000-0000000000{:02}", id_suffix),
            "device_id": "0191aaaa-0000-7000-8000-000000000001",
            "user_id": "0191aaaa-0000-7000-8000-000000000002",
            "organization_id": "0191aaaa-0000-7000-8000-000000000003",
            "occurred_at": "2026-07-17T10:00:00.000Z",
            "monotonic_ms": 1000,
            "source": "demo",
            "app": { "display_name": format!("Salesforce {MARKER}"), "domain": "acme.lightning.force.com" },
            "event_type": "record_opened",
            "target": { "role": "row", "semantic_type": MARKER },
            "context": { "object_type": "account" },
            "duration_ms": 1500,
            "sensitivity": "internal",
            "redaction": { "applied": false, "reasons": [] }
        })
    }

    async fn open_store(dir: &tempfile::TempDir) -> (LocalStore, std::path::PathBuf) {
        let path = dir.path().join("test.sqlite");
        let store = LocalStore::open(&path, &StaticKeyProvider(TEST_KEY), "user-1")
            .await
            .expect("store opens");
        (store, path)
    }

    #[tokio::test]
    async fn persists_encrypted_and_decrypts_via_timeline() {
        let dir = tempdir().unwrap();
        let (store, _) = open_store(&dir).await;
        store.insert_event(&sample_event(1), 30).await.unwrap();
        let timeline = store.timeline(10, 0).await.unwrap();
        assert_eq!(timeline.len(), 1);
        assert!(timeline[0].app_display_name.contains(MARKER));
        assert_eq!(timeline[0].app_category, "crm");
        store.close().await;
    }

    #[tokio::test]
    async fn outbox_enqueues_redacted_projection_without_identity() {
        let dir = tempdir().unwrap();
        let (store, _) = open_store(&dir).await;
        let event = json!({
            "schema_version": 1,
            "event_id": "0191bbbb-0000-7000-8000-000000000001",
            "occurred_at": "2026-07-18T10:00:00.000Z",
            "monotonic_ms": 4242,
            "source": "macos_ax",
            "app": { "display_name": "Salesforce ACME_SECRET_NAME", "domain": "acme.my.salesforce.com" },
            "event_type": "record_update",
            "target": { "role": "row", "semantic_type": "save_button" },
            "context": { "object_type": "account", "item_count": 14 },
            "duration_ms": 1500,
            "sensitivity": "internal",
            "redaction": { "applied": false, "reasons": [] }
        });
        store.insert_event(&event, 30).await.unwrap();

        let drained = store.outbox_drain(10).await.unwrap();
        assert_eq!(drained.len(), 1);
        let msg = &drained[0];
        assert_eq!(msg.message_type, "event");
        let payload = &msg.payload;

        // Identity/raw content must NOT be present in the projection.
        let serialized = payload.to_string();
        assert!(!serialized.contains("ACME_SECRET_NAME"), "app name leaked");
        assert!(!serialized.contains("salesforce.com"), "domain leaked");
        assert!(!serialized.contains("display_name"), "raw field leaked");

        // Safe, redacted fields ARE present.
        assert_eq!(payload["app_category"], "crm");
        assert_eq!(payload["source"], "macos_ax");
        assert_eq!(payload["semantic_type"], "save_button");
        assert_eq!(payload["object_type"], "account");
        assert_eq!(payload["item_count_bucket"], "11_50");
        assert_eq!(payload["excluded_from_learning"], false);
        store.close().await;
    }

    #[tokio::test]
    async fn outbox_ack_removes_and_defer_delays_redelivery() {
        let dir = tempdir().unwrap();
        let (store, _) = open_store(&dir).await;
        store.insert_event(&sample_event(1), 30).await.unwrap();
        store.insert_event(&sample_event(2), 30).await.unwrap();
        assert_eq!(store.outbox_depth().await.unwrap(), 2);

        let drained = store.outbox_drain(10).await.unwrap();
        assert_eq!(drained.len(), 2);

        // Ack the first → it is gone; one remains.
        store.outbox_ack(&[drained[0].outbox_id.clone()]).await.unwrap();
        assert_eq!(store.outbox_depth().await.unwrap(), 1);

        // Defer the remaining with a long backoff → not due, so drain sees none,
        // but it is still queued (at-least-once, retried later).
        store.outbox_defer(&[drained[1].outbox_id.clone()], 3600).await.unwrap();
        assert_eq!(store.outbox_drain(10).await.unwrap().len(), 0);
        assert_eq!(store.outbox_depth().await.unwrap(), 1);
        store.close().await;
    }

    #[tokio::test]
    async fn deleting_an_event_purges_its_queued_projection() {
        let dir = tempdir().unwrap();
        let (store, _) = open_store(&dir).await;
        store.insert_event(&sample_event(1), 30).await.unwrap();
        assert_eq!(store.outbox_depth().await.unwrap(), 1);

        let event_id = sample_event(1)["event_id"].as_str().unwrap().to_string();
        assert!(store.delete_event(&event_id).await.unwrap());
        // A deleted event can never sync: its projection left the outbox too.
        assert_eq!(store.outbox_depth().await.unwrap(), 0);
        assert_eq!(store.tombstone_count().await.unwrap(), 1);
        store.close().await;
    }

    #[tokio::test]
    async fn deleting_app_history_purges_queued_projections_for_that_app() {
        let dir = tempdir().unwrap();
        let (store, _) = open_store(&dir).await;
        store.insert_event(&sample_event(1), 30).await.unwrap();
        store.insert_event(&sample_event(2), 30).await.unwrap();
        assert_eq!(store.outbox_depth().await.unwrap(), 2);
        // Both sample events share the same app display name (same app_hmac).
        let removed = store
            .delete_app_history(&format!("Salesforce {MARKER}"))
            .await
            .unwrap();
        assert_eq!(removed, 2);
        assert_eq!(store.outbox_depth().await.unwrap(), 0);
        store.close().await;
    }

    #[tokio::test]
    async fn no_plaintext_sensitive_content_in_database_file() {
        let dir = tempdir().unwrap();
        let (store, path) = open_store(&dir).await;
        for i in 0..5 {
            store.insert_event(&sample_event(i), 30).await.unwrap();
        }
        store.close().await;
        let raw = std::fs::read(&path).unwrap();
        let haystack = String::from_utf8_lossy(&raw);
        assert!(
            !haystack.contains(MARKER),
            "sensitive fixture marker must not appear in SQLite file"
        );
        assert!(!haystack.contains("acme.lightning.force.com"));
    }

    #[tokio::test]
    async fn nonces_are_unique_per_record() {
        let dir = tempdir().unwrap();
        let (store, _) = open_store(&dir).await;
        let a = store.encrypt(b"same plaintext", b"aad").unwrap();
        let b = store.encrypt(b"same plaintext", b"aad").unwrap();
        assert_ne!(a[..12], b[..12], "nonces must differ");
        assert_ne!(a[12..], b[12..], "ciphertexts must differ");
        store.close().await;
    }

    #[tokio::test]
    async fn aad_binds_table_record_schema_and_owner() {
        let dir = tempdir().unwrap();
        let (store, _) = open_store(&dir).await;
        let blob = store
            .encrypt(b"payload", &store.aad("workflow_events", "id-1", 1))
            .unwrap();
        // Right AAD decrypts; any changed component fails authentication.
        assert!(store.decrypt(&blob, &store.aad("workflow_events", "id-1", 1)).is_ok());
        assert!(store.decrypt(&blob, &store.aad("workflow_events", "id-2", 1)).is_err());
        assert!(store.decrypt(&blob, &store.aad("workflow_episodes", "id-1", 1)).is_err());
        assert!(store.decrypt(&blob, &store.aad("workflow_events", "id-1", 2)).is_err());
        store.close().await;
    }

    #[tokio::test]
    async fn rejects_forbidden_fields() {
        let dir = tempdir().unwrap();
        let (store, _) = open_store(&dir).await;
        let mut bad = sample_event(9);
        bad["target"]["password"] = json!("hunter2");
        let err = store.insert_event(&bad, 30).await.unwrap_err();
        assert!(matches!(err, StoreError::ForbiddenField(f) if f == "password"));
        assert_eq!(store.count_events().await.unwrap(), 0);
        store.close().await;
    }

    #[tokio::test]
    async fn deletion_removes_rows_and_writes_tombstones() {
        let dir = tempdir().unwrap();
        let (store, _) = open_store(&dir).await;
        store.insert_event(&sample_event(1), 30).await.unwrap();
        store.insert_event(&sample_event(2), 30).await.unwrap();
        let id = store.timeline(10, 0).await.unwrap()[0].event_id.clone();
        assert!(store.delete_event(&id).await.unwrap());
        assert_eq!(store.count_events().await.unwrap(), 1);
        assert_eq!(store.tombstone_count().await.unwrap(), 1);
        assert_eq!(store.delete_all_events().await.unwrap(), 1);
        assert_eq!(store.count_events().await.unwrap(), 0);
        assert_eq!(store.tombstone_count().await.unwrap(), 2);
        store.close().await;
    }

    #[tokio::test]
    async fn app_history_deletion_uses_keyed_hmac() {
        let dir = tempdir().unwrap();
        let (store, _) = open_store(&dir).await;
        store.insert_event(&sample_event(1), 30).await.unwrap();
        let mut other = sample_event(2);
        other["app"]["display_name"] = json!("Google Sheets");
        store.insert_event(&other, 30).await.unwrap();
        let removed = store
            .delete_app_history(&format!("Salesforce {MARKER}"))
            .await
            .unwrap();
        assert_eq!(removed, 1);
        assert_eq!(store.count_events().await.unwrap(), 1);
        store.close().await;
    }

    #[tokio::test]
    async fn retention_sweep_removes_expired_only_and_keeps_tombstones() {
        let dir = tempdir().unwrap();
        let (store, _) = open_store(&dir).await;
        // Create a tombstone first (delete event 3), then insert one already
        // expired event (-1 day retention) and one live event (30 days).
        store.insert_event(&sample_event(3), 30).await.unwrap();
        store
            .delete_event("0191aaaa-0000-7000-8000-000000000003")
            .await
            .unwrap();
        store.insert_event(&sample_event(1), -1).await.unwrap();
        store.insert_event(&sample_event(2), 30).await.unwrap();

        let before_tombstones = store.tombstone_count().await.unwrap();
        let swept = store.sweep_retention().await.unwrap();
        assert_eq!(swept, 1, "only the expired event is swept");
        assert_eq!(store.count_events().await.unwrap(), 1);
        // Tombstones are never deleted by retention.
        assert_eq!(store.tombstone_count().await.unwrap(), before_tombstones);
        store.close().await;
    }

    #[tokio::test]
    async fn quarantines_undecryptable_rows_instead_of_crashing() {
        let dir = tempdir().unwrap();
        let (store, path) = open_store(&dir).await;
        store.insert_event(&sample_event(1), 30).await.unwrap();
        store.close().await;

        // Re-open with a DIFFERENT key: decryption must fail gracefully.
        let store2 = LocalStore::open(&path, &StaticKeyProvider([9u8; 32]), "user-1")
            .await
            .unwrap();
        let timeline = store2.timeline(10, 0).await.unwrap();
        assert_eq!(timeline.len(), 0, "row is quarantined, not returned or panicking");
        // Original data still present but marked quarantined.
        assert_eq!(store2.count_events().await.unwrap(), 1);
        store2.close().await;
    }

    #[tokio::test]
    async fn outbox_enqueues_encrypted_and_reports_depth() {
        let dir = tempdir().unwrap();
        let (store, path) = open_store(&dir).await;
        store
            .outbox_enqueue("pattern_summary", &json!({"intent": MARKER}))
            .await
            .unwrap();
        assert_eq!(store.outbox_depth().await.unwrap(), 1);
        store.close().await;
        let raw = std::fs::read(&path).unwrap();
        assert!(!String::from_utf8_lossy(&raw).contains(MARKER));
    }

    #[test]
    fn iso_formatting_is_correct() {
        assert_eq!(iso_from_unix_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_from_unix_ms(1_784_311_200_123), "2026-07-17T18:00:00.123Z");
        assert_eq!(iso_from_unix_ms(951_782_400_000), "2000-02-29T00:00:00.000Z"); // leap day
    }

    #[test]
    fn app_categorization() {
        assert_eq!(categorize_app("Salesforce", Some("acme.lightning.force.com")), "crm");
        assert_eq!(categorize_app("Google Sheets", Some("docs.google.com")), "spreadsheet");
        assert_eq!(categorize_app("Gmail", Some("mail.google.com")), "email");
        assert_eq!(categorize_app("LinkedIn", Some("linkedin.com")), "research");
        assert_eq!(categorize_app("Some Site", Some("example.com")), "browser");
        assert_eq!(categorize_app("TextEdit", None), "other");
    }
}
