//! Native messaging protocol handling: framing, origin allowlist, envelope
//! structure, timestamp window, and nonce replay cache.
//!
//! HMAC authentication is verified by the desktop core (which holds the shared
//! secret in the Keychain); this host enforces everything it can enforce
//! WITHOUT holding key material, then forwards over the local socket.

use serde::Deserialize;
use std::collections::HashSet;
use std::io::{Read, Write};
use std::time::{SystemTime, UNIX_EPOCH};

pub const MESSAGE_MAX_AGE_MS: i64 = 60_000;
pub const MAX_MESSAGE_BYTES: u32 = 1024 * 1024;
pub const NONCE_CACHE_MAX: usize = 4096;

/// Only these extension origins may talk to this host. The production ID is
/// injected at install time by scripts/install-native-host-macos.sh; the
/// development ID is documented in docs/architecture/extension-pairing.md.
pub const DEFAULT_ALLOWED_ORIGIN_PREFIX: &str = "chrome-extension://";

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum ProtocolError {
    #[error("message too large")]
    TooLarge,
    #[error("malformed frame")]
    BadFrame,
    #[error("invalid JSON: {0}")]
    BadJson(String),
    #[error("origin not allowed")]
    OriginDenied,
    #[error("timestamp outside the 60s window")]
    Expired,
    #[error("nonce replayed")]
    Replayed,
    #[error("missing field: {0}")]
    MissingField(&'static str),
}

/// Chrome native messaging framing: u32 little-endian length + JSON bytes.
pub fn read_frame(reader: &mut impl Read) -> Result<Option<serde_json::Value>, ProtocolError> {
    let mut len_bytes = [0u8; 4];
    match reader.read_exact(&mut len_bytes) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(_) => return Err(ProtocolError::BadFrame),
    }
    let len = u32::from_le_bytes(len_bytes);
    if len > MAX_MESSAGE_BYTES {
        return Err(ProtocolError::TooLarge);
    }
    let mut buf = vec![0u8; len as usize];
    reader.read_exact(&mut buf).map_err(|_| ProtocolError::BadFrame)?;
    serde_json::from_slice(&buf).map_err(|e| ProtocolError::BadJson(e.to_string())).map(Some)
}

pub fn write_frame(writer: &mut impl Write, value: &serde_json::Value) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(value)?;
    writer.write_all(&(bytes.len() as u32).to_le_bytes())?;
    writer.write_all(&bytes)?;
    writer.flush()
}

/// Chrome passes the calling extension origin as argv[1].
pub fn origin_allowed(origin: Option<&str>, allowed_ids: &[String]) -> bool {
    let Some(origin) = origin else { return false };
    let Some(id) = origin
        .strip_prefix(DEFAULT_ALLOWED_ORIGIN_PREFIX)
        .map(|rest| rest.trim_end_matches('/'))
    else {
        return false;
    };
    allowed_ids.iter().any(|allowed| allowed == id)
}

#[derive(Debug, Deserialize)]
pub struct Envelope {
    pub message_id: String,
    pub installation_id: String,
    pub timestamp: String,
    pub nonce: String,
    pub payload: serde_json::Value,
    pub signature: String,
}

/// Bounded nonce replay cache (FIFO eviction).
#[derive(Default)]
pub struct NonceCache {
    seen: HashSet<String>,
    order: Vec<String>,
}

impl NonceCache {
    pub fn check_and_insert(&mut self, nonce: &str) -> Result<(), ProtocolError> {
        if self.seen.contains(nonce) {
            return Err(ProtocolError::Replayed);
        }
        if self.order.len() >= NONCE_CACHE_MAX {
            let evicted = self.order.remove(0);
            self.seen.remove(&evicted);
        }
        self.seen.insert(nonce.to_string());
        self.order.push(nonce.to_string());
        Ok(())
    }
}

/// Parses RFC3339-ish "YYYY-MM-DDTHH:MM:SS(.mmm)Z" to unix ms (UTC only).
pub fn parse_iso_ms(ts: &str) -> Option<i64> {
    let ts = ts.strip_suffix('Z')?;
    let (date, time) = ts.split_once('T')?;
    let mut date_parts = date.split('-');
    let (y, mo, d): (i64, i64, i64) = (
        date_parts.next()?.parse().ok()?,
        date_parts.next()?.parse().ok()?,
        date_parts.next()?.parse().ok()?,
    );
    let mut time_parts = time.split(':');
    let (h, mi) = (
        time_parts.next()?.parse::<i64>().ok()?,
        time_parts.next()?.parse::<i64>().ok()?,
    );
    let sec_str = time_parts.next()?;
    let (s, ms): (i64, i64) = match sec_str.split_once('.') {
        Some((s, frac)) => (
            s.parse().ok()?,
            format!("{:0<3}", frac.chars().take(3).collect::<String>()).parse().ok()?,
        ),
        None => (sec_str.parse().ok()?, 0),
    };
    // days-from-civil
    let y_adj = if mo <= 2 { y - 1 } else { y };
    let era = y_adj.div_euclid(400);
    let yoe = y_adj - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 86_400 + h * 3_600 + mi * 60 + s) * 1_000) + ms)
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Structural + freshness + replay validation of a signed envelope.
pub fn validate_envelope(
    value: &serde_json::Value,
    nonce_cache: &mut NonceCache,
    now_unix_ms: i64,
) -> Result<Envelope, ProtocolError> {
    let envelope: Envelope = serde_json::from_value(value.clone())
        .map_err(|e| ProtocolError::BadJson(e.to_string()))?;
    if envelope.message_id.is_empty() {
        return Err(ProtocolError::MissingField("message_id"));
    }
    if envelope.signature.len() != 64 || !envelope.signature.chars().all(|c| c.is_ascii_hexdigit())
    {
        return Err(ProtocolError::MissingField("signature"));
    }
    let ts = parse_iso_ms(&envelope.timestamp).ok_or(ProtocolError::Expired)?;
    if (now_unix_ms - ts).abs() > MESSAGE_MAX_AGE_MS {
        return Err(ProtocolError::Expired);
    }
    nonce_cache.check_and_insert(&envelope.nonce)?;
    Ok(envelope)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn envelope_json(nonce: &str, ts: &str) -> serde_json::Value {
        json!({
            "message_id": "m1",
            "installation_id": "i1",
            "timestamp": ts,
            "nonce": nonce,
            "payload": {"type": "semantic_event"},
            "signature": "ab".repeat(32),
        })
    }

    const NOW: i64 = 1_784_311_200_000; // 2026-07-17T18:00:00Z

    #[test]
    fn frame_round_trip() {
        let value = json!({"a": 1});
        let mut buf = Vec::new();
        write_frame(&mut buf, &value).unwrap();
        let mut cursor = std::io::Cursor::new(buf);
        assert_eq!(read_frame(&mut cursor).unwrap(), Some(value));
        assert_eq!(read_frame(&mut cursor).unwrap(), None); // EOF
    }

    #[test]
    fn oversized_frames_rejected() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&(MAX_MESSAGE_BYTES + 1).to_le_bytes());
        assert_eq!(
            read_frame(&mut std::io::Cursor::new(buf)).unwrap_err(),
            ProtocolError::TooLarge
        );
    }

    #[test]
    fn origin_allowlist_is_strict() {
        let allowed = vec!["abcdefghijklmnop".to_string()];
        assert!(origin_allowed(Some("chrome-extension://abcdefghijklmnop/"), &allowed));
        assert!(origin_allowed(Some("chrome-extension://abcdefghijklmnop"), &allowed));
        assert!(!origin_allowed(Some("chrome-extension://evilextension000/"), &allowed));
        assert!(!origin_allowed(Some("https://evil.example"), &allowed));
        assert!(!origin_allowed(None, &allowed));
    }

    #[test]
    fn parses_iso_timestamps() {
        assert_eq!(parse_iso_ms("2026-07-17T18:00:00.000Z"), Some(NOW));
        assert_eq!(parse_iso_ms("2026-07-17T18:00:00Z"), Some(NOW));
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(parse_iso_ms("garbage"), None);
    }

    #[test]
    fn fresh_envelope_validates_once() {
        let mut cache = NonceCache::default();
        let value = envelope_json("n1", "2026-07-17T18:00:00.000Z");
        assert!(validate_envelope(&value, &mut cache, NOW + 1000).is_ok());
        // replay
        assert_eq!(
            validate_envelope(&value, &mut cache, NOW + 2000).unwrap_err(),
            ProtocolError::Replayed
        );
    }

    #[test]
    fn stale_and_future_messages_rejected() {
        let mut cache = NonceCache::default();
        let old = envelope_json("n2", "2026-07-17T17:58:59.000Z"); // 61s old
        assert_eq!(
            validate_envelope(&old, &mut cache, NOW).unwrap_err(),
            ProtocolError::Expired
        );
        let future = envelope_json("n3", "2026-07-17T18:01:01.000Z"); // 61s ahead
        assert_eq!(
            validate_envelope(&future, &mut cache, NOW).unwrap_err(),
            ProtocolError::Expired
        );
    }

    #[test]
    fn malformed_signature_rejected() {
        let mut cache = NonceCache::default();
        let mut value = envelope_json("n4", "2026-07-17T18:00:00.000Z");
        value["signature"] = json!("short");
        assert!(matches!(
            validate_envelope(&value, &mut cache, NOW).unwrap_err(),
            ProtocolError::MissingField("signature")
        ));
    }

    #[test]
    fn nonce_cache_evicts_fifo_and_stays_bounded() {
        let mut cache = NonceCache::default();
        for i in 0..(NONCE_CACHE_MAX + 10) {
            cache.check_and_insert(&format!("n{i}")).unwrap();
        }
        assert!(cache.seen.len() <= NONCE_CACHE_MAX);
        // earliest nonce was evicted → re-insert allowed (window semantics:
        // the 60s timestamp check is the primary guard; cache handles bursts)
        assert!(cache.check_and_insert("n0").is_ok());
    }
}
