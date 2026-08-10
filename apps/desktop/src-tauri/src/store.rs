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
use std::sync::Arc;
use std::time::Duration;

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
    #[error("keychain access blocked or timed out — macOS did not release the store key")]
    KeyTimeout,
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

/// How long the first keychain attempt may block before store commands get an
/// honest `KeyTimeout` instead of hanging on the store mutex.
pub const KEY_FIRST_WAIT: Duration = Duration::from_secs(10);
/// How long later store commands wait on the still-pending attempt before
/// failing fast with the same honest error.
pub const KEY_RETRY_WAIT: Duration = Duration::from_millis(500);

/// Timeout-guarded, single-flight key acquisition.
///
/// macOS securityd can block a keyring call indefinitely — observed live when
/// the "Always Allow" ACL confirmation dialog never rendered for the
/// accessory-style app after a rebuild+re-sign. The keyring call therefore runs
/// on a dedicated OS thread (never an async worker), and callers wait with a
/// timeout so the store mutex is released and every store command surfaces an
/// error the UI can render instead of hanging.
///
/// Single-flight: a timed-out attempt is parked, not abandoned — retries wait
/// on the SAME thread, so at most one thread is ever stuck in securityd, and
/// the moment the user approves access the pending attempt completes and the
/// next store command opens the store without another prompt.
pub struct GuardedKeyAcquire {
    pending: std::sync::Mutex<Option<tokio::sync::oneshot::Receiver<Result<[u8; 32], StoreError>>>>,
}

impl Default for GuardedKeyAcquire {
    fn default() -> Self {
        Self::new()
    }
}

impl GuardedKeyAcquire {
    pub fn new() -> Self {
        Self { pending: std::sync::Mutex::new(None) }
    }

    pub async fn acquire(
        &self,
        provider: Arc<dyn KeyProvider>,
        first_wait: Duration,
        retry_wait: Duration,
    ) -> Result<[u8; 32], StoreError> {
        let (mut rx, wait) = {
            let mut slot = self.pending.lock().expect("key acquire lock");
            match slot.take() {
                Some(rx) => (rx, retry_wait),
                None => {
                    let (tx, rx) = tokio::sync::oneshot::channel();
                    std::thread::spawn(move || {
                        let _ = tx.send(provider.get_or_create_key());
                    });
                    (rx, first_wait)
                }
            }
        };
        match tokio::time::timeout(wait, &mut rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(StoreError::Key("key acquisition thread died".into())),
            Err(_) => {
                // Still blocked in securityd: park the attempt for the next call.
                *self.pending.lock().expect("key acquire lock") = Some(rx);
                Err(StoreError::KeyTimeout)
            }
        }
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
  expires_at TEXT NOT NULL,
  -- Domain-pack classification (L1); NULL = unclassified, a valid state.
  pack_domain TEXT,
  domain_object TEXT,
  domain_action TEXT,
  classifier_confidence REAL
);
CREATE INDEX IF NOT EXISTS idx_events_occurred ON workflow_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_pack_domain ON workflow_events (pack_domain);
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
  suppressed_until TEXT,
  template_id TEXT
);
CREATE TABLE IF NOT EXISTS suggestion_history (
  recommendation_local_id TEXT PRIMARY KEY,
  pattern_id TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT,
  occurred_at TEXT NOT NULL
);
-- Layer 5 surfacing outcomes: what the user decided about a card, and the
-- context it was shown in. This is the LOCAL training set for a future learned
-- surfacing policy, so its privacy shape matters: pack taxonomy ids, enums and
-- small integers only. There is deliberately no column that can hold a label,
-- window title, account name or any other captured content, and nothing here is
-- ever uploaded (no sync_outbox projection writes to it).
CREATE TABLE IF NOT EXISTS suggestion_outcomes (
  outcome_id TEXT PRIMARY KEY,
  pattern_id TEXT NOT NULL,
  workflow_id TEXT,
  pack_domain TEXT,
  cadence TEXT,
  surface TEXT,
  outcome TEXT NOT NULL,
  reason TEXT,
  local_dow INTEGER NOT NULL,
  local_hour INTEGER NOT NULL,
  cadence_phase TEXT,
  seconds_since_trigger INTEGER,
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
-- Replay-fidelity step sequences for verifying candidate agents against the
-- worker's own recorded runs. LOCAL-ONLY, tier two of the two-tier model:
-- richer than any synced projection, and NEVER referenced by sync_outbox —
-- no code path enqueues from this table. Never uploaded.
CREATE TABLE IF NOT EXISTS episode_traces (
  episode_id TEXT PRIMARY KEY,
  pattern_signature TEXT NOT NULL,
  started_at TEXT NOT NULL,
  encrypted_payload BLOB NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_traces_signature ON episode_traces (pattern_signature, started_at DESC);
"#;

/// Additive column migrations for databases created before the columns existed
/// (SQLite CREATE TABLE IF NOT EXISTS never alters an existing table). Each is
/// safe to re-run: a duplicate-column error means it is already applied.
const COLUMN_MIGRATIONS: &[&str] = &[
    "ALTER TABLE pattern_candidates ADD COLUMN runs_tested INTEGER",
    "ALTER TABLE pattern_candidates ADD COLUMN runs_matched INTEGER",
    "ALTER TABLE pattern_candidates ADD COLUMN last_verified_at TEXT",
    // Encrypted per-run replay results (incl. divergence step). Local-only.
    "ALTER TABLE pattern_candidates ADD COLUMN verification_detail BLOB",
    // Domain-pack classification (L1). Plaintext columns because they are typed
    // abstractions in the same privacy class as app_category — pack taxonomy ids
    // only, never content. NULL means unclassified, which is a valid state.
    "ALTER TABLE workflow_events ADD COLUMN pack_domain TEXT",
    "ALTER TABLE workflow_events ADD COLUMN domain_object TEXT",
    "ALTER TABLE workflow_events ADD COLUMN domain_action TEXT",
    "ALTER TABLE workflow_events ADD COLUMN classifier_confidence REAL",
    // L2 template recognition: "<pack_domain>/<workflow_id>", NULL for novel
    // patterns. Plaintext taxonomy id, same privacy class as app_category.
    "ALTER TABLE pattern_candidates ADD COLUMN template_id TEXT",
    // Which verification implementation produced runs_tested/runs_matched.
    // NULL = written by the pre-VERIFICATION_SCHEMA logic, whose scores cannot
    // be trusted (see DATA_MIGRATIONS).
    "ALTER TABLE pattern_candidates ADD COLUMN verification_schema INTEGER",
];

/// Current verification implementation. Bump when a change invalidates stored
/// scores, and add the matching invalidation to DATA_MIGRATIONS.
pub const VERIFICATION_SCHEMA: i64 = 2;

/// One-time DATA migrations, run after the column migrations.
///
/// Each must be idempotent: they run on every open, so every statement is
/// guarded by the state it repairs (a `WHERE` that stops matching once applied).
const DATA_MIGRATIONS: &[&str] = &[
    // INVALIDATE PRE-SCHEMA-2 VERIFICATION SCORES.
    //
    // Schema 1 replay could return `verdict: "match"` after filtering every
    // step out of the comparison, so a pattern whose tokens carried neither
    // semantic_type nor object_type scored a full match against ANY trace —
    // including unrelated and empty ones. Real devices persisted rows such as
    // 21 tested / 21 matched that proved nothing, and the UI showed them a
    // "verified" badge.
    //
    // Those numbers cannot be re-interpreted, only discarded: clear them so the
    // pattern reverts to unverified and is re-checked by the current logic on
    // the next pass. The candidate row itself, its history and its traces are
    // untouched — only the false claim is removed.
    "UPDATE pattern_candidates
       SET runs_tested = NULL,
           runs_matched = NULL,
           last_verified_at = NULL,
           verification_detail = NULL
     WHERE verification_schema IS NULL
       AND (runs_tested IS NOT NULL OR runs_matched IS NOT NULL)",
];

pub struct LocalStore {
    pool: SqlitePool,
    key: [u8; 32],
    owner_user_id: String,
    /// Loaded domain packs, used to classify at ingest. Empty is valid and
    /// simply means nothing gets classified — observation still works.
    packs: Vec<crate::domain::DomainPack>,
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
        Self::open_with_packs(db_path, key_provider, owner_user_id, Vec::new()).await
    }

    /// Same, with domain packs for the L1 classifier.
    ///
    /// NOTE: acquires the key synchronously on the calling task. The production
    /// path uses `GuardedKeyAcquire` + `open_with_key` instead, so a keychain
    /// call blocked in securityd can never hang the store mutex.
    pub async fn open_with_packs(
        db_path: &Path,
        key_provider: &dyn KeyProvider,
        owner_user_id: &str,
        packs: Vec<crate::domain::DomainPack>,
    ) -> Result<Self, StoreError> {
        let key = key_provider.get_or_create_key()?;
        Self::open_with_key(db_path, key, owner_user_id, packs).await
    }

    /// Opens the store with an already-acquired key.
    pub async fn open_with_key(
        db_path: &Path,
        key: [u8; 32],
        owner_user_id: &str,
        packs: Vec<crate::domain::DomainPack>,
    ) -> Result<Self, StoreError> {
        let options = SqliteConnectOptions::from_str(&format!("sqlite://{}", db_path.display()))
            .map_err(StoreError::Db)?
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(options)
            .await?;
        sqlx::raw_sql(SCHEMA_SQL).execute(&pool).await?;
        for migration in COLUMN_MIGRATIONS {
            // Duplicate-column = already applied; anything else is a real error.
            if let Err(e) = sqlx::query(migration).execute(&pool).await {
                let msg = e.to_string();
                if !msg.contains("duplicate column name") {
                    return Err(StoreError::Db(e));
                }
            }
        }
        // Data migrations run AFTER the columns they reference exist. These are
        // not best-effort: a failure here would leave a known-false verification
        // claim in place, so it propagates.
        for migration in DATA_MIGRATIONS {
            sqlx::query(migration).execute(&pool).await?;
        }
        Ok(Self {
            pool,
            key,
            owner_user_id: owner_user_id.to_string(),
            packs,
        })
    }

    /// Loaded packs, for `packs_status`.
    pub fn packs(&self) -> &[crate::domain::DomainPack] {
        &self.packs
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

        // Domain classification (L1) — post-redaction, pre-storage. Never forces
        // a mapping: no match leaves every column NULL.
        let classification = crate::domain::classify_event(
            self.packs.as_slice(),
            &crate::domain::input_from_payload(event, &app_category),
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
              encrypted_payload, payload_sha256, excluded_from_learning, quarantined, expires_at,
              pack_domain, domain_object, domain_action, classifier_confidence)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?)",
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
        .bind(classification.as_ref().map(|c| c.domain.clone()))
        .bind(classification.as_ref().and_then(|c| c.object.clone()))
        .bind(classification.as_ref().and_then(|c| c.action.clone()))
        .bind(classification.as_ref().map(|c| c.confidence))
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
        // When the store holds more events than the limit, keep the NEWEST
        // window, not the oldest: patterns are detected in what the user does
        // now, and an oldest-first cut silently freezes the engine's view at
        // the point the store outgrew the limit (observed live at 10k). The
        // inner query picks the newest N; the outer restores ascending order,
        // which segmentation requires.
        let rows = sqlx::query(
            "SELECT * FROM (
                SELECT event_id, occurred_at, source, app_category, event_type, sensitivity,
                       encrypted_payload, excluded_from_learning, quarantined,
                       pack_domain, domain_object, domain_action, classifier_confidence
                FROM workflow_events
                ORDER BY occurred_at DESC LIMIT ?
             ) ORDER BY occurred_at ASC",
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
            // Domain classification, read from the plaintext columns. Named
            // pack_domain (not domain) because in this projection `domain` means
            // a WEB domain and must never appear — see the contracts tests.
            if let Some(d) = row.get::<Option<String>, _>("pack_domain") {
                feature["pack_domain"] = serde_json::json!(d);
            }
            if let Some(o) = row.get::<Option<String>, _>("domain_object") {
                feature["domain_object"] = serde_json::json!(o);
            }
            if let Some(a) = row.get::<Option<String>, _>("domain_action") {
                feature["domain_action"] = serde_json::json!(a);
            }
            if let Some(c) = row.get::<Option<f64>, _>("classifier_confidence") {
                feature["classifier_confidence"] = serde_json::json!(c);
            }
            features.push(feature);
        }
        Ok(features)
    }

    /// (classified, total) event counts over the trailing `days` window,
    /// excluding quarantined rows — the packs_status coverage number.
    pub async fn classifier_coverage(&self, days: i64) -> Result<(i64, i64), StoreError> {
        let since = iso_days_from_now(-days);
        let row = sqlx::query(
            "SELECT
               COUNT(*) AS total,
               SUM(CASE WHEN pack_domain IS NOT NULL THEN 1 ELSE 0 END) AS classified
             FROM workflow_events WHERE occurred_at >= ? AND quarantined = 0",
        )
        .bind(&since)
        .fetch_one(&self.pool)
        .await?;
        let total: i64 = row.get("total");
        let classified: i64 = row.try_get::<Option<i64>, _>("classified")?.unwrap_or(0);
        Ok((classified, total))
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

    // ---- replay verification (two-tier local data; see episode_traces DDL) ----

    /// Upserts replay-fidelity episode traces. LOCAL-ONLY BY CONSTRUCTION:
    /// unlike `insert_event`, this never enqueues anything to `sync_outbox` —
    /// traces are richer than any synced projection and never leave the device.
    pub async fn traces_save(&self, traces: &[serde_json::Value]) -> Result<u64, StoreError> {
        let mut saved = 0u64;
        for trace in traces {
            let episode_id = trace
                .get("episode_id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| StoreError::InvalidPayload("missing episode_id".into()))?;
            let signature = trace
                .get("pattern_signature")
                .and_then(|v| v.as_str())
                .ok_or_else(|| StoreError::InvalidPayload("missing pattern_signature".into()))?;
            let started_at = trace
                .get("started_at")
                .and_then(|v| v.as_str())
                .ok_or_else(|| StoreError::InvalidPayload("missing started_at".into()))?;
            let aad = self.aad("episode_traces", episode_id, 1);
            let plaintext = serde_json::to_vec(trace)
                .map_err(|e| StoreError::InvalidPayload(e.to_string()))?;
            let blob = self.encrypt(&plaintext, &aad)?;
            sqlx::query(
                "INSERT INTO episode_traces (episode_id, pattern_signature, started_at, encrypted_payload, created_at)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(episode_id) DO UPDATE SET
                   pattern_signature = excluded.pattern_signature,
                   started_at = excluded.started_at,
                   encrypted_payload = excluded.encrypted_payload",
            )
            .bind(episode_id)
            .bind(signature)
            .bind(started_at)
            .bind(blob)
            .bind(now_iso())
            .execute(&self.pool)
            .await?;
            saved += 1;
        }
        Ok(saved)
    }

    /// The most recent traces recorded for a pattern (decrypted, newest first).
    pub async fn traces_for_pattern(
        &self,
        signature: &str,
        limit: i64,
    ) -> Result<Vec<serde_json::Value>, StoreError> {
        let rows = sqlx::query(
            "SELECT episode_id, encrypted_payload FROM episode_traces
             WHERE pattern_signature = ? ORDER BY started_at DESC LIMIT ?",
        )
        .bind(signature)
        .bind(limit.clamp(1, 500))
        .fetch_all(&self.pool)
        .await?;
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            let episode_id: String = row.get("episode_id");
            let blob: Vec<u8> = row.get("encrypted_payload");
            let aad = self.aad("episode_traces", &episode_id, 1);
            if let Ok(pt) = self.decrypt(&blob, &aad) {
                if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&pt) {
                    out.push(v);
                }
            }
        }
        Ok(out)
    }

    /// Upserts a computed pattern candidate row (encrypted full candidate JSON).
    /// Verification columns are preserved on update — they are owned by
    /// `candidate_verification_save`.
    pub async fn candidate_upsert(
        &self,
        pattern_id: &str,
        status: &str,
        opportunity_score: f64,
        first_seen_at: &str,
        last_seen_at: &str,
        candidate: &serde_json::Value,
    ) -> Result<(), StoreError> {
        let aad = self.aad("pattern_candidates", pattern_id, 1);
        let plaintext = serde_json::to_vec(candidate)
            .map_err(|e| StoreError::InvalidPayload(e.to_string()))?;
        let blob = self.encrypt(&plaintext, &aad)?;
        // Optional: present only for template-recognized candidates.
        let template_id = candidate.get("template_id").and_then(|v| v.as_str());
        sqlx::query(
            "INSERT INTO pattern_candidates
               (pattern_id, status, opportunity_score, encrypted_payload, payload_sha256, first_seen_at, last_seen_at, template_id)
             VALUES (?, ?, ?, ?, '', ?, ?, ?)
             ON CONFLICT(pattern_id) DO UPDATE SET
               status = excluded.status,
               opportunity_score = excluded.opportunity_score,
               encrypted_payload = excluded.encrypted_payload,
               first_seen_at = excluded.first_seen_at,
               last_seen_at = excluded.last_seen_at,
               template_id = excluded.template_id",
        )
        .bind(pattern_id)
        .bind(status)
        .bind(opportunity_score)
        .bind(blob)
        .bind(first_seen_at)
        .bind(last_seen_at)
        .bind(template_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Records a replay-verification outcome on the candidate row. The per-run
    /// detail (incl. divergence steps) is encrypted; only the counts are plain.
    pub async fn candidate_verification_save(
        &self,
        pattern_id: &str,
        runs_tested: i64,
        runs_matched: i64,
        detail: &serde_json::Value,
    ) -> Result<bool, StoreError> {
        let aad = self.aad("pattern_candidates:verification", pattern_id, 1);
        let plaintext = serde_json::to_vec(detail)
            .map_err(|e| StoreError::InvalidPayload(e.to_string()))?;
        let blob = self.encrypt(&plaintext, &aad)?;
        let result = sqlx::query(
            "UPDATE pattern_candidates
             SET runs_tested = ?, runs_matched = ?, last_verified_at = ?, verification_detail = ?,
                 verification_schema = ?
             WHERE pattern_id = ?",
        )
        .bind(runs_tested)
        .bind(runs_matched)
        .bind(now_iso())
        .bind(blob)
        // Stamps WHICH implementation produced these numbers, so a future
        // correctness fix can invalidate them precisely instead of guessing.
        .bind(VERIFICATION_SCHEMA)
        .bind(pattern_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    /// Card-ready verification report for one candidate: counts + decrypted
    /// per-run results ("tested N, matched M, diverged at step X on run Y").
    pub async fn verification_report(
        &self,
        pattern_id: &str,
    ) -> Result<Option<serde_json::Value>, StoreError> {
        let row = sqlx::query(
            "SELECT runs_tested, runs_matched, last_verified_at, verification_detail
             FROM pattern_candidates WHERE pattern_id = ?",
        )
        .bind(pattern_id)
        .fetch_optional(&self.pool)
        .await?;
        let Some(row) = row else { return Ok(None) };
        let runs_tested: Option<i64> = row.get("runs_tested");
        let runs_matched: Option<i64> = row.get("runs_matched");
        let last_verified_at: Option<String> = row.get("last_verified_at");
        let detail_blob: Option<Vec<u8>> = row.get("verification_detail");
        let detail = detail_blob.and_then(|blob| {
            let aad = self.aad("pattern_candidates:verification", pattern_id, 1);
            self.decrypt(&blob, &aad)
                .ok()
                .and_then(|pt| serde_json::from_slice::<serde_json::Value>(&pt).ok())
        });
        Ok(Some(serde_json::json!({
            "pattern_id": pattern_id,
            "runs_tested": runs_tested,
            "runs_matched": runs_matched,
            "last_verified_at": last_verified_at,
            "detail": detail,
        })))
    }

    /// Appends a suggestion action (accepted / suppressed / never, with reason)
    /// to the local history ledger.
    pub async fn suggestion_history_log(
        &self,
        pattern_id: &str,
        action: &str,
        reason: Option<&str>,
    ) -> Result<(), StoreError> {
        sqlx::query(
            "INSERT INTO suggestion_history (recommendation_local_id, pattern_id, action, reason, occurred_at)
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(uuid_like_id())
        .bind(pattern_id)
        .bind(action)
        .bind(reason)
        .bind(now_iso())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Dates read from labels inside the observer, paired with the pack
    /// classification of the event they came from (Layer 5 date-driven triggers).
    ///
    /// This is a SEPARATE read path from `pattern_features` on purpose. Feature
    /// projections are the learning/sync-shaped view and must not carry a value
    /// read off the user's record; this one is explicitly local — nothing calls
    /// it but the panel, and no sync projection reads from it.
    ///
    /// Only classified events are returned: an unclassified date has no pack
    /// trigger to belong to, so surfacing it would serve no purpose.
    pub async fn watched_dates(&self, limit: i64) -> Result<Vec<serde_json::Value>, StoreError> {
        let rows = sqlx::query(
            "SELECT event_id, occurred_at, encrypted_payload, pack_domain, domain_object
             FROM workflow_events
             WHERE quarantined = 0 AND pack_domain IS NOT NULL AND domain_object IS NOT NULL
             ORDER BY occurred_at DESC LIMIT ?",
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;

        let mut out = Vec::new();
        for row in rows {
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
            let Some(dates) = payload
                .pointer("/target/label_dates")
                .and_then(|v| v.as_array())
            else {
                continue;
            };
            for entry in dates {
                // Re-validate on the way out: the shape is bounded here too, so a
                // payload written by an older build cannot widen what is exposed.
                let Some(date) = entry.get("date").and_then(|v| v.as_str()) else {
                    continue;
                };
                if date.len() != 10 || !date.is_char_boundary(10) {
                    continue;
                }
                let confidence = entry
                    .get("confidence")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.0);
                out.push(serde_json::json!({
                    "occurred_at": row.get::<String, _>("occurred_at"),
                    "pack_domain": row.get::<Option<String>, _>("pack_domain"),
                    "domain_object": row.get::<Option<String>, _>("domain_object"),
                    "date": date,
                    "confidence": confidence,
                }));
            }
        }
        Ok(out)
    }

    /// Appends a Layer 5 surfacing outcome with its context features.
    ///
    /// Every field is validated or bounded before it lands: the caller is the
    /// webview, so a bad `local_dow` or a stray content string must not become
    /// a poisoned training row. Out-of-range numbers and over-long identifiers
    /// are rejected rather than clamped — a wrong row is worse than no row.
    #[allow(clippy::too_many_arguments)]
    pub async fn suggestion_outcome_log(
        &self,
        pattern_id: &str,
        workflow_id: Option<&str>,
        pack_domain: Option<&str>,
        cadence: Option<&str>,
        surface: Option<&str>,
        outcome: &str,
        reason: Option<&str>,
        local_dow: i64,
        local_hour: i64,
        cadence_phase: Option<&str>,
        seconds_since_trigger: Option<i64>,
    ) -> Result<(), StoreError> {
        const OUTCOMES: [&str; 5] = ["accepted", "snoozed", "dismissed", "never_suggest", "wrong"];
        const CADENCES: [&str; 5] = [
            "continuous",
            "fiscal_monthly",
            "weekly",
            "date_driven",
            "event_driven",
        ];
        const SURFACES: [&str; 4] = [
            "pre_close",
            "on_trigger",
            "same_weekday_observed",
            "after_verification",
        ];
        const PHASES: [&str; 3] = ["pre_close", "in_close", "mid_period"];

        fn taxonomy_ok(v: &str) -> bool {
            !v.is_empty()
                && v.len() <= 48
                && v
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
        }
        fn one_of(v: Option<&str>, allowed: &[&str]) -> Result<(), StoreError> {
            match v {
                None => Ok(()),
                Some(x) if allowed.contains(&x) => Ok(()),
                Some(_) => Err(StoreError::InvalidPayload("value outside allowed set".into())),
            }
        }

        if pattern_id.is_empty() || pattern_id.len() > 128 {
            return Err(StoreError::InvalidPayload("pattern_id length".into()));
        }
        for taxonomy in [workflow_id, pack_domain] {
            if let Some(v) = taxonomy {
                if !taxonomy_ok(v) {
                    return Err(StoreError::InvalidPayload("taxonomy id shape".into()));
                }
            }
        }
        if !OUTCOMES.contains(&outcome) {
            return Err(StoreError::InvalidPayload("unknown outcome".into()));
        }
        one_of(cadence, &CADENCES)?;
        one_of(surface, &SURFACES)?;
        one_of(cadence_phase, &PHASES)?;
        // Reason is a closed vocabulary, so it can never carry free-form content.
        one_of(
            reason,
            &[
                "not_useful",
                "wrong_pattern",
                "too_risky",
                "not_now",
                "never_suggest",
                "other",
            ],
        )?;
        if !(0..=6).contains(&local_dow) || !(0..=23).contains(&local_hour) {
            return Err(StoreError::InvalidPayload("dow/hour out of range".into()));
        }
        if let Some(s) = seconds_since_trigger {
            if s < 0 {
                return Err(StoreError::InvalidPayload("negative seconds_since_trigger".into()));
            }
        }

        sqlx::query(
            "INSERT INTO suggestion_outcomes (
               outcome_id, pattern_id, workflow_id, pack_domain, cadence, surface,
               outcome, reason, local_dow, local_hour, cadence_phase,
               seconds_since_trigger, occurred_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(uuid_like_id())
        .bind(pattern_id)
        .bind(workflow_id)
        .bind(pack_domain)
        .bind(cadence)
        .bind(surface)
        .bind(outcome)
        .bind(reason)
        .bind(local_dow)
        .bind(local_hour)
        .bind(cadence_phase)
        .bind(seconds_since_trigger)
        .bind(now_iso())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// How many outcome rows are recorded (surfaced in Privacy so the user can
    /// see the size of the local training set, and delete it).
    pub async fn suggestion_outcome_count(&self) -> Result<i64, StoreError> {
        let row: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM suggestion_outcomes")
            .fetch_one(&self.pool)
            .await?;
        Ok(row.0)
    }

    /// Non-mutating peek at the next queued sync payloads (decrypted) so the
    /// user can see exactly what would leave the device. Read-only: no drain,
    /// no attempt bump.
    pub async fn outbox_peek(&self, limit: i64) -> Result<Vec<serde_json::Value>, StoreError> {
        let rows = sqlx::query(
            "SELECT outbox_id, message_type, encrypted_payload FROM sync_outbox
             ORDER BY created_at ASC LIMIT ?",
        )
        .bind(limit.clamp(1, 50))
        .fetch_all(&self.pool)
        .await?;
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            let outbox_id: String = row.get("outbox_id");
            let message_type: String = row.get("message_type");
            let blob: Vec<u8> = row.get("encrypted_payload");
            let aad = self.aad("sync_outbox", &outbox_id, 1);
            if let Ok(pt) = self.decrypt(&blob, &aad) {
                if let Ok(payload) = serde_json::from_slice::<serde_json::Value>(&pt) {
                    out.push(serde_json::json!({
                        "message_type": message_type,
                        "payload": payload,
                    }));
                }
            }
        }
        Ok(out)
    }

    pub async fn close(&self) {
        self.pool.close().await;
    }
}

/// Deterministic-enough local id for ledger rows (no uuid crate dependency here).
fn uuid_like_id() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    let h = bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
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

/// Known domains → coarse category. Matched exact-host-or-subdomain ONLY (the
/// same tightened idiom as the M18.7 allowlist lookalike fix) — a looser
/// contains/ends_with form would wrongly admit lookalikes like
/// `evil-salesforce.com.attacker.com`.
const DOMAIN_CATEGORIES: &[(&str, &str)] = &[
    ("salesforce.com", "crm"),
    ("force.com", "crm"),
    ("lightning.force.com", "crm"),
    ("docs.google.com", "spreadsheet"),
    ("mail.google.com", "email"),
    ("calendar.google.com", "calendar"),
    ("linkedin.com", "research"),
    ("slack.com", "messaging"),
    ("teams.microsoft.com", "messaging"),
];

/// Maps app identity to the coarse category exposed to the pattern engine.
/// The domain, when present, is authoritative; the display name is only a
/// fallback (native apps have no domain, and browser display names derive
/// from the domain anyway).
pub fn categorize_app(display_name: &str, domain: Option<&str>) -> String {
    if let Some(domain) = domain {
        let d = domain.to_lowercase();
        // Exact host or a subdomain of a known host ONLY (see DOMAIN_CATEGORIES).
        for (host, category) in DOMAIN_CATEGORIES {
            if d == *host || d.ends_with(&format!(".{host}")) {
                return (*category).to_string();
            }
        }
    }
    let name = display_name.to_lowercase();
    if name.contains("salesforce") || name.contains("force.com") || name.contains("hubspot") {
        "crm"
    } else if name.contains("sheets") || name.contains("excel") || name.contains("airtable") {
        "spreadsheet"
    } else if name.contains("gmail") || name.contains("mail") || name.contains("outlook") {
        "email"
    } else if name.contains("calendar") {
        "calendar"
    } else if name.contains("linkedin") || name.contains("apollo") || name.contains("zoominfo") {
        "research"
    } else if name.contains("slack") || name.contains("teams") || name.contains("discord") {
        "messaging"
    } else if name.contains("chrome") || domain.is_some() {
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
    async fn traces_and_verification_roundtrip_and_stay_out_of_the_outbox() {
        let dir = tempdir().unwrap();
        let (store, _) = open_store(&dir).await;

        // Save two replay traces for a pattern.
        let traces = vec![
            json!({"episode_id": "ep-1", "pattern_signature": "sig-a", "started_at": "2026-07-30T10:00:00.000Z", "tokens": ["a:b:c:d:e:f"]}),
            json!({"episode_id": "ep-2", "pattern_signature": "sig-a", "started_at": "2026-07-31T10:00:00.000Z", "tokens": ["a:b:c:d:e:f", "g:h:i:j:k:l"]}),
        ];
        assert_eq!(store.traces_save(&traces).await.unwrap(), 2);
        let loaded = store.traces_for_pattern("sig-a", 10).await.unwrap();
        assert_eq!(loaded.len(), 2);
        // Newest first.
        assert_eq!(loaded[0]["episode_id"], "ep-2");

        // Two-tier invariant: saving traces enqueues NOTHING to sync_outbox.
        assert_eq!(store.outbox_depth().await.unwrap(), 0);

        // Candidate + verification roundtrip — the card's numbers come from here.
        store
            .candidate_upsert("pat-1", "candidate", 0.72, "2026-07-01T00:00:00.000Z", "2026-07-31T00:00:00.000Z", &json!({"pattern_id": "pat-1"}))
            .await
            .unwrap();
        let detail = json!([{"episode_id": "ep-1", "verdict": "match"}, {"episode_id": "ep-2", "verdict": "partial", "divergence_step": 2}]);
        assert!(store.candidate_verification_save("pat-1", 21, 19, &detail).await.unwrap());
        let report = store.verification_report("pat-1").await.unwrap().unwrap();
        assert_eq!(report["runs_tested"], 21);
        assert_eq!(report["runs_matched"], 19);
        assert_eq!(report["detail"][1]["divergence_step"], 2);
        assert!(report["last_verified_at"].as_str().unwrap().len() > 10);

        // Unknown pattern → None (no fabricated report).
        assert!(store.verification_report("nope").await.unwrap().is_none());

        // Suggestion history ledger appends.
        store.suggestion_history_log("pat-1", "never", Some("not my workflow")).await.unwrap();
        store.close().await;
    }

    /// The Layer 5 outcome ledger is a training set, so a poisoned row is worse
    /// than a missing one: every field is validated before it lands.
    #[tokio::test]
    async fn suggestion_outcomes_reject_bad_rows_and_never_store_content() {
        let dir = tempdir().unwrap();
        let (store, _) = open_store(&dir).await;

        store
            .suggestion_outcome_log(
                "pat-1",
                Some("month_end_accruals"),
                Some("finops"),
                Some("fiscal_monthly"),
                Some("pre_close"),
                "accepted",
                None,
                3,
                14,
                Some("pre_close"),
                Some(3600),
            )
            .await
            .unwrap();
        assert_eq!(store.suggestion_outcome_count().await.unwrap(), 1);

        // A free-text "reason" is the obvious way content would leak in — the
        // closed vocabulary refuses it.
        let leak = store
            .suggestion_outcome_log(
                "pat-1",
                None,
                None,
                None,
                None,
                "dismissed",
                Some("Acme Corp invoice INV-4471 looked wrong"),
                3,
                14,
                None,
                None,
            )
            .await;
        assert!(leak.is_err(), "free-form reason must be rejected");

        // Unknown outcome, out-of-range clock fields, and a workflow_id that is
        // really a sentence are all rejected.
        for bad in [
            store
                .suggestion_outcome_log("p", None, None, None, None, "loved_it", None, 1, 1, None, None)
                .await,
            store
                .suggestion_outcome_log("p", None, None, None, None, "accepted", None, 9, 1, None, None)
                .await,
            store
                .suggestion_outcome_log("p", None, None, None, None, "accepted", None, 1, 99, None, None)
                .await,
            store
                .suggestion_outcome_log(
                    "p",
                    Some("Reviewing Acme's renewal"),
                    None,
                    None,
                    None,
                    "accepted",
                    None,
                    1,
                    1,
                    None,
                    None,
                )
                .await,
            store
                .suggestion_outcome_log("p", None, None, Some("hourly"), None, "accepted", None, 1, 1, None, None)
                .await,
            store
                .suggestion_outcome_log("", None, None, None, None, "accepted", None, 1, 1, None, None)
                .await,
        ] {
            assert!(bad.is_err(), "invalid outcome row must be rejected");
        }

        // Only the one good row survived.
        assert_eq!(store.suggestion_outcome_count().await.unwrap(), 1);
        store.close().await;
    }

    #[tokio::test]
    async fn outbox_peek_is_read_only() {
        let dir = tempdir().unwrap();
        let (store, _) = open_store(&dir).await;
        store.insert_event(&sample_event(41), 30).await.unwrap();
        let before = store.outbox_depth().await.unwrap();
        let peeked = store.outbox_peek(10).await.unwrap();
        assert_eq!(peeked.len() as i64, before);
        // Peeking neither drains nor bumps attempts: a drain still returns it.
        assert_eq!(store.outbox_depth().await.unwrap(), before);
        assert_eq!(store.outbox_drain(10).await.unwrap().len() as i64, before);
        // The peeked payload is the redacted projection (no display name).
        let s = serde_json::to_string(&peeked).unwrap();
        assert!(!s.contains("Salesforce"), "peek must show the projection, not raw identity");
        store.close().await;
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
        assert_eq!(categorize_app("LinkedIn", Some("www.linkedin.com")), "research");
        assert_eq!(categorize_app("Slack", Some("app.slack.com")), "messaging");
        assert_eq!(categorize_app("Some Site", Some("example.com")), "browser");
        assert_eq!(categorize_app("TextEdit", None), "other");
    }

    #[test]
    fn app_categorization_domain_is_authoritative() {
        // Exact host and subdomains of known CRM/productivity hosts — the
        // extension-derived display name ("Chrome"/whatever) is irrelevant.
        assert_eq!(categorize_app("Chrome", Some("salesforce.com")), "crm");
        assert_eq!(categorize_app("Chrome", Some("acme.my.salesforce.com")), "crm");
        assert_eq!(categorize_app("Chrome", Some("force.com")), "crm");
        assert_eq!(categorize_app("Chrome", Some("acme.lightning.force.com")), "crm");
        assert_eq!(categorize_app("Chrome", Some("docs.google.com")), "spreadsheet");
        assert_eq!(categorize_app("Chrome", Some("mail.google.com")), "email");
        assert_eq!(categorize_app("Chrome", Some("calendar.google.com")), "calendar");
        // Case-insensitive on the domain.
        assert_eq!(categorize_app("Chrome", Some("ACME.Lightning.Force.com")), "crm");
    }

    #[test]
    fn app_categorization_rejects_lookalike_domains() {
        // None of these are a known host or a subdomain of one — they must
        // stay "browser", never "crm"/"spreadsheet"/"email".
        for lookalike in [
            "evil-salesforce.com.attacker.com",
            "salesforce.com.attacker.com",
            "notsalesforce.com",
            "salesforce.company.io",
            "xn--salesforce.com.evil.example",
            "docs.google.com.evil.example",
            "mail.google.com.evil.example",
        ] {
            assert_eq!(
                categorize_app("Chrome", Some(lookalike)),
                "browser",
                "lookalike {lookalike} must not be categorized as a known app"
            );
        }
    }

    #[test]
    fn app_categorization_display_name_fallback_still_works() {
        // Native apps (no domain) keep the display-name heuristics.
        assert_eq!(categorize_app("Salesforce", None), "crm");
        assert_eq!(categorize_app("Microsoft Excel", None), "spreadsheet");
        assert_eq!(categorize_app("Microsoft Outlook", None), "email");
        assert_eq!(categorize_app("Calendar", None), "calendar");
        assert_eq!(categorize_app("Slack", None), "messaging");
    }
}

#[cfg(test)]
mod domain_ingest_tests {
    //! Classification at ingest (L1): post-redaction, pre-storage, never forced.
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    const TEST_KEY: [u8; 32] = [9u8; 32];

    fn packs() -> Vec<crate::domain::DomainPack> {
        crate::domain::load_packs(
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../domain/packs"),
        )
    }

    fn crm_event(id_suffix: u32, object_type: &str) -> serde_json::Value {
        json!({
            "schema_version": 1,
            "event_id": format!("0191bbbb-0000-7000-8000-0000000000{:02}", id_suffix),
            "device_id": "0191bbbb-0000-7000-8000-000000000001",
            "user_id": "0191bbbb-0000-7000-8000-000000000002",
            "organization_id": "0191bbbb-0000-7000-8000-000000000003",
            "occurred_at": now_iso(),
            "monotonic_ms": 1000,
            "source": "chrome",
            "app": { "display_name": "Salesforce", "domain": "acme.lightning.force.com" },
            "event_type": "record_opened",
            "target": { "role": "row" },
            "context": { "object_type": object_type },
            "duration_ms": 1500,
            "sensitivity": "internal",
            "redaction": { "applied": false, "reasons": [] }
        })
    }

    /// Dates read from labels must reach Layer 5 WITHOUT entering the learning
    /// projection — that separation is the whole privacy argument for emitting
    /// them at all, so it is pinned here rather than left to code review.
    #[tokio::test]
    async fn watched_dates_are_local_only_and_never_in_pattern_features() {
        let dir = tempdir().unwrap();
        let store = LocalStore::open_with_packs(
            &dir.path().join("t.sqlite"),
            &StaticKeyProvider(TEST_KEY),
            "user-1",
            packs(),
        )
        .await
        .unwrap();

        let mut event = crm_event(11, "renewal");
        event["target"] = json!({
            "role": "row",
            "label_pattern_hits": ["renewal"],
            "label_dates": [{ "date": "2026-08-25", "confidence": 0.95 }]
        });
        store.insert_event(&event, 30).await.unwrap();

        // Local path: the date arrives with the pack classification it belongs to.
        let watched = store.watched_dates(50).await.unwrap();
        assert_eq!(watched.len(), 1, "expected one watched date, got {watched:?}");
        assert_eq!(watched[0]["date"], "2026-08-25");
        assert_eq!(watched[0]["pack_domain"], "revops");
        assert_eq!(watched[0]["domain_object"], "renewal");

        // Learning projection: the date must appear NOWHERE in it.
        let features = store.pattern_features(50).await.unwrap();
        let serialized = serde_json::to_string(&features).unwrap();
        assert!(
            !serialized.contains("2026-08-25"),
            "a value read off a record must not enter the feature projection: {serialized}"
        );
        assert!(!serialized.contains("label_dates"));
    }

    /// An unclassified event's date has no pack trigger to belong to, so it is
    /// never surfaced.
    #[tokio::test]
    async fn watched_dates_skips_unclassified_events() {
        let dir = tempdir().unwrap();
        let store = LocalStore::open_with_packs(
            &dir.path().join("t.sqlite"),
            &StaticKeyProvider(TEST_KEY),
            "user-1",
            packs(),
        )
        .await
        .unwrap();

        let mut event = crm_event(12, "definitely_not_an_object");
        event["target"] = json!({
            "label_dates": [{ "date": "2026-08-25", "confidence": 0.95 }]
        });
        store.insert_event(&event, 30).await.unwrap();

        assert!(store.watched_dates(50).await.unwrap().is_empty());
    }

    /// A stored verification score written by the pre-schema-2 replay logic is a
    /// claim we now know could be vacuous (a "match" over zero compared steps).
    /// Re-opening the store must discard it so the pattern reads as unverified,
    /// while leaving the candidate itself intact — and must NOT touch a score
    /// stamped by the current implementation.
    #[tokio::test]
    async fn legacy_verification_scores_are_invalidated_not_trusted() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("t.sqlite");
        let candidate = json!({ "pattern_id": "p-legacy", "status": "eligible" });

        {
            let store =
                LocalStore::open(&path, &StaticKeyProvider(TEST_KEY), "user-1").await.unwrap();
            store
                .candidate_upsert("p-legacy", "eligible", 0.7, "2026-08-01", "2026-08-05", &candidate)
                .await
                .unwrap();
            // Simulate the old writer: scores present, no schema stamp.
            sqlx::query(
                "UPDATE pattern_candidates
                   SET runs_tested = 21, runs_matched = 21, last_verified_at = '2026-08-07T00:00:00Z',
                       verification_schema = NULL
                 WHERE pattern_id = 'p-legacy'",
            )
            .execute(&store.pool)
            .await
            .unwrap();
        }

        // Re-open: the data migration runs.
        let store = LocalStore::open(&path, &StaticKeyProvider(TEST_KEY), "user-1").await.unwrap();
        let row: (Option<i64>, Option<i64>, Option<String>) = sqlx::query_as(
            "SELECT runs_tested, runs_matched, last_verified_at FROM pattern_candidates
              WHERE pattern_id = 'p-legacy'",
        )
        .fetch_one(&store.pool)
        .await
        .unwrap();
        assert_eq!(row.0, None, "stale runs_tested must be cleared");
        assert_eq!(row.1, None, "stale runs_matched must be cleared");
        assert_eq!(row.2, None, "stale last_verified_at must be cleared");

        // The candidate itself survives — only the false claim was removed.
        let still_there: i64 =
            sqlx::query_scalar("SELECT count(*) FROM pattern_candidates WHERE pattern_id = 'p-legacy'")
                .fetch_one(&store.pool)
                .await
                .unwrap();
        assert_eq!(still_there, 1);

        // A score written by the CURRENT implementation is stamped and preserved
        // across the next open.
        store
            .candidate_verification_save("p-legacy", 5, 4, &json!([]))
            .await
            .unwrap();
        drop(store);
        let store = LocalStore::open(&path, &StaticKeyProvider(TEST_KEY), "user-1").await.unwrap();
        let kept: (Option<i64>, Option<i64>, Option<i64>) = sqlx::query_as(
            "SELECT runs_tested, runs_matched, verification_schema FROM pattern_candidates
              WHERE pattern_id = 'p-legacy'",
        )
        .fetch_one(&store.pool)
        .await
        .unwrap();
        assert_eq!(kept, (Some(5), Some(4), Some(VERIFICATION_SCHEMA)));
    }

    #[tokio::test]
    async fn classification_persists_and_flows_to_pattern_features() {
        let dir = tempdir().unwrap();
        let store = LocalStore::open_with_packs(
            &dir.path().join("t.sqlite"),
            &StaticKeyProvider(TEST_KEY),
            "user-1",
            packs(),
        )
        .await
        .unwrap();

        // A CRM opportunity event classifies into revops…
        store.insert_event(&crm_event(1, "opportunity"), 30).await.unwrap();
        // …and an event with no domain signal stays NULL, never forced.
        store.insert_event(&crm_event(2, "definitely_not_an_object"), 30).await.unwrap();

        let features = store.pattern_features(10).await.unwrap();
        assert_eq!(features.len(), 2);
        let classified = features
            .iter()
            .find(|f| f["event_id"].as_str().unwrap().ends_with("01"))
            .unwrap();
        assert_eq!(classified["pack_domain"], "revops");
        assert_eq!(classified["domain_object"], "opportunity");
        assert!(classified["classifier_confidence"].as_f64().unwrap() > 0.0);
        // The projection never carries a web domain under any name.
        assert!(classified.get("domain").is_none());

        let unclassified = features
            .iter()
            .find(|f| f["event_id"].as_str().unwrap().ends_with("02"))
            .unwrap();
        assert!(unclassified.get("pack_domain").is_none());
        assert!(unclassified.get("domain_object").is_none());
    }

    /// When the store holds more events than the feature limit, the projection
    /// must keep the NEWEST window, in ascending order. The first live store to
    /// cross the limit proved the stakes: an oldest-first cut silently froze
    /// the engine's view at the moment the store outgrew the limit, so the
    /// user's most recent work never reached pattern detection.
    #[tokio::test]
    async fn pattern_features_keeps_the_newest_events_when_over_limit() {
        let dir = tempdir().unwrap();
        let store = LocalStore::open(
            &dir.path().join("t.sqlite"),
            &StaticKeyProvider(TEST_KEY),
            "user-1",
        )
        .await
        .unwrap();

        for i in 1..=5u32 {
            let mut event = crm_event(i, "opportunity");
            event["occurred_at"] = json!(format!("2026-08-01T00:00:0{i}.000Z"));
            store.insert_event(&event, 30).await.unwrap();
        }

        let features = store.pattern_features(3).await.unwrap();
        let ids: Vec<&str> = features.iter().map(|f| f["event_id"].as_str().unwrap()).collect();
        // The newest three (03..05) survive — 01 and 02 fall off, not the tail.
        assert_eq!(
            ids,
            vec![
                "0191bbbb-0000-7000-8000-000000000003",
                "0191bbbb-0000-7000-8000-000000000004",
                "0191bbbb-0000-7000-8000-000000000005",
            ]
        );
        // And segmentation's precondition holds: ascending occurred_at.
        let times: Vec<&str> =
            features.iter().map(|f| f["occurred_at"].as_str().unwrap()).collect();
        let mut sorted = times.clone();
        sorted.sort_unstable();
        assert_eq!(times, sorted);
    }

    #[tokio::test]
    async fn no_packs_means_no_classification_and_ingest_still_works() {
        let dir = tempdir().unwrap();
        let store = LocalStore::open(
            &dir.path().join("t.sqlite"),
            &StaticKeyProvider(TEST_KEY),
            "user-1",
        )
        .await
        .unwrap();
        store.insert_event(&crm_event(3, "opportunity"), 30).await.unwrap();
        let features = store.pattern_features(10).await.unwrap();
        assert_eq!(features.len(), 1);
        assert!(features[0].get("pack_domain").is_none());
    }

    #[tokio::test]
    async fn classifier_coverage_counts_classified_vs_total() {
        let dir = tempdir().unwrap();
        let store = LocalStore::open_with_packs(
            &dir.path().join("t.sqlite"),
            &StaticKeyProvider(TEST_KEY),
            "user-1",
            packs(),
        )
        .await
        .unwrap();
        store.insert_event(&crm_event(4, "opportunity"), 30).await.unwrap();
        store.insert_event(&crm_event(5, "definitely_not_an_object"), 30).await.unwrap();
        let (classified, total) = store.classifier_coverage(7).await.unwrap();
        assert_eq!((classified, total), (1, 2));
    }

    #[tokio::test]
    async fn migration_is_rerunnable_on_a_database_created_before_the_columns() {
        // open() runs SCHEMA_SQL + COLUMN_MIGRATIONS; opening twice must not error
        // (duplicate-column swallowed), and the columns must exist afterwards.
        let dir = tempdir().unwrap();
        let path = dir.path().join("t.sqlite");
        for _ in 0..2 {
            let store = LocalStore::open(&path, &StaticKeyProvider(TEST_KEY), "user-1")
                .await
                .unwrap();
            drop(store);
        }
        let store = LocalStore::open_with_packs(
            &path,
            &StaticKeyProvider(TEST_KEY),
            "user-1",
            packs(),
        )
        .await
        .unwrap();
        store.insert_event(&crm_event(6, "invoice"), 30).await.unwrap();
        let (classified, total) = store.classifier_coverage(7).await.unwrap();
        assert_eq!((classified, total), (1, 1));
    }
}

#[cfg(test)]
mod label_hit_ingest_tests {
    //! Label-pattern hits (observer → ingest): the strongest L1 signal.
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    #[tokio::test]
    async fn label_hits_classify_an_event_that_has_no_other_domain_signal() {
        let dir = tempdir().unwrap();
        let packs = crate::domain::load_packs(
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../domain/packs"),
        );
        let store = LocalStore::open_with_packs(
            &dir.path().join("t.sqlite"),
            &StaticKeyProvider([11u8; 32]),
            "user-1",
            packs,
        )
        .await
        .unwrap();

        // An AX event with NO object_type/semantic hint — only the pattern
        // strings the observer matched pre-hash. This is exactly what the
        // Swift hook emits for e.g. a NetSuite invoice window.
        let event = json!({
            "schema_version": 1,
            "event_id": "0191cccc-0000-7000-8000-000000000001",
            "device_id": "0191cccc-0000-7000-8000-000000000002",
            "user_id": "0191cccc-0000-7000-8000-000000000003",
            "organization_id": "0191cccc-0000-7000-8000-000000000004",
            "occurred_at": now_iso(),
            "monotonic_ms": 1000,
            "source": "macos_ax",
            "app": { "display_name": "NetSuite", "bundle_id": "com.netsuite.app" },
            "event_type": "element_focused",
            "target": {
                "role": "AXTextField",
                "label_pattern_hits": ["invoice", "amount due"]
            },
            "context": {},
            "sensitivity": "internal",
            "redaction": { "applied": false, "reasons": [] }
        });
        store.insert_event(&event, 30).await.unwrap();
        let features = store.pattern_features(10).await.unwrap();
        assert_eq!(features.len(), 1);
        assert_eq!(features[0]["pack_domain"], "finops");
        assert_eq!(features[0]["domain_object"], "invoice");
    }
}

#[cfg(test)]
mod key_acquire_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{mpsc, Mutex};

    /// Blocks inside get_or_create_key until the test releases it — stands in
    /// for securityd waiting on an ACL confirmation dialog that never renders.
    struct BlockingProvider {
        release: Mutex<mpsc::Receiver<[u8; 32]>>,
        calls: AtomicUsize,
    }

    impl KeyProvider for BlockingProvider {
        fn get_or_create_key(&self) -> Result<[u8; 32], StoreError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.release
                .lock()
                .expect("release lock")
                .recv()
                .map_err(|_| StoreError::Key("release channel closed".into()))
        }
    }

    #[tokio::test]
    async fn blocked_keychain_times_out_instead_of_deadlocking() {
        let (release, rx) = mpsc::channel();
        let provider = Arc::new(BlockingProvider {
            release: Mutex::new(rx),
            calls: AtomicUsize::new(0),
        });
        let acquire = GuardedKeyAcquire::new();
        let first_wait = Duration::from_millis(100);
        let retry_wait = Duration::from_millis(20);

        // The blocked provider surfaces an honest KeyTimeout, promptly.
        let started = std::time::Instant::now();
        let first = acquire.acquire(provider.clone(), first_wait, retry_wait).await;
        assert!(matches!(first, Err(StoreError::KeyTimeout)), "got {first:?}");
        assert!(started.elapsed() < Duration::from_secs(5), "must not deadlock");

        // Retries fail fast on the SAME in-flight attempt — never a second
        // thread parked in securityd.
        let second = acquire.acquire(provider.clone(), first_wait, retry_wait).await;
        assert!(matches!(second, Err(StoreError::KeyTimeout)));
        assert_eq!(provider.calls.load(Ordering::SeqCst), 1);

        // The user finally clicks "Always Allow": the parked attempt completes
        // and the next call returns the key without prompting again.
        release.send([7u8; 32]).unwrap();
        let third = acquire
            .acquire(provider.clone(), Duration::from_secs(5), Duration::from_secs(5))
            .await;
        assert_eq!(third.unwrap(), [7u8; 32]);
        assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn key_errors_pass_through_and_allow_a_fresh_attempt() {
        // A COMPLETED failure (not a timeout) must not stay parked: the next
        // acquire tries the provider again (e.g. the user re-granted access).
        let (release, rx) = mpsc::channel();
        drop(release); // provider errors immediately
        let provider = Arc::new(BlockingProvider {
            release: Mutex::new(rx),
            calls: AtomicUsize::new(0),
        });
        let acquire = GuardedKeyAcquire::new();
        let wait = Duration::from_secs(5);

        let first = acquire.acquire(provider.clone(), wait, wait).await;
        assert!(matches!(first, Err(StoreError::Key(_))), "got {first:?}");
        let second = acquire.acquire(provider.clone(), wait, wait).await;
        assert!(matches!(second, Err(StoreError::Key(_))));
        assert_eq!(provider.calls.load(Ordering::SeqCst), 2);
    }
}
