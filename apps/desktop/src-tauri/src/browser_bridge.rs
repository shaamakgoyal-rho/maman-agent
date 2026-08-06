//! Desktop side of the browser-extension bridge.
//!
//! The native host connects over a local Unix socket (JSON lines) and
//! forwards pairing requests and signed envelopes. This module owns the
//! authoritative security decisions:
//! - one-time pairing tokens: only the SHA-256 hash is stored, 5 minute expiry
//! - the long-lived shared secret lives in the macOS Keychain
//! - HMAC-SHA256 verification over canonical JSON (sorted keys), matching the
//!   extension's `canonicalJson` exactly
//! - verified semantic shapes run through the SAME gate → redact → encrypt
//!   pipeline as every other event

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};

pub const PAIRING_TOKEN_TTL_MS: i64 = 5 * 60 * 1000;
pub const BROWSER_SECRET_ACCOUNT: &str = "browser-extension-secret";

#[derive(serde::Serialize, serde::Deserialize)]
pub struct PendingPairing {
    pub token_sha256: String,
    pub expires_at_ms: i64,
}

pub fn now_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn sha256_hex(input: &[u8]) -> String {
    hex::encode(Sha256::digest(input))
}

pub fn base64url_encode(bytes: &[u8]) -> String {
    // Minimal base64url without padding (no extra dependency).
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(CHARS[(n >> 18) as usize & 63] as char);
        out.push(CHARS[(n >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(CHARS[(n >> 6) as usize & 63] as char);
        }
        if chunk.len() > 2 {
            out.push(CHARS[n as usize & 63] as char);
        }
    }
    out
}

pub fn base64url_decode(input: &str) -> Option<Vec<u8>> {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let index = |c: u8| CHARS.iter().position(|&x| x == c);
    let bytes: Vec<u8> = input.bytes().collect();
    let mut out = Vec::new();
    for chunk in bytes.chunks(4) {
        let mut n: u32 = 0;
        let mut bits = 0;
        for &c in chunk {
            n = (n << 6) | index(c)? as u32;
            bits += 6;
        }
        n <<= 24 - bits.min(24);
        if bits >= 8 {
            out.push((n >> 16) as u8);
        }
        if bits >= 16 {
            out.push((n >> 8) as u8);
        }
        if bits >= 24 {
            out.push(n as u8);
        }
    }
    Some(out)
}

/// Canonical JSON matching the extension's `canonicalJson`: recursively sorted
/// object keys, arrays in order, compact separators, JSON string escaping.
pub fn canonical_json(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Object(map) => {
            let sorted: BTreeMap<_, _> = map.iter().collect();
            let entries: Vec<String> = sorted
                .into_iter()
                .map(|(k, v)| {
                    format!("{}:{}", serde_json::to_string(k).unwrap_or_default(), canonical_json(v))
                })
                .collect();
            format!("{{{}}}", entries.join(","))
        }
        serde_json::Value::Array(items) => {
            let entries: Vec<String> = items.iter().map(canonical_json).collect();
            format!("[{}]", entries.join(","))
        }
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

/// Verifies the envelope HMAC using the shared secret (base64url).
pub fn verify_envelope_hmac(envelope: &serde_json::Value, secret_b64url: &str) -> bool {
    let Some(signature) = envelope.get("signature").and_then(|v| v.as_str()) else {
        return false;
    };
    let signing_input = canonical_json(&serde_json::json!({
        "message_id": envelope.get("message_id"),
        "installation_id": envelope.get("installation_id"),
        "timestamp": envelope.get("timestamp"),
        "nonce": envelope.get("nonce"),
        "payload": envelope.get("payload"),
    }));
    let Some(key) = base64url_decode(secret_b64url) else { return false };
    let Ok(mut mac) = <Hmac<Sha256> as Mac>::new_from_slice(&key) else { return false };
    mac.update(signing_input.as_bytes());
    let expected = hex::encode(mac.finalize().into_bytes());
    // constant-time compare
    if expected.len() != signature.len() {
        return false;
    }
    expected
        .bytes()
        .zip(signature.bytes())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

/// Signs an envelope exactly the way the extension's `signEnvelope` does.
///
/// This exists because actuation reverses the direction of the channel: until
/// now the desktop only ever VERIFIED envelopes the extension sent. When the
/// desktop pushes an action request the other way, the extension has to be able
/// to tell that it came from here and not from the native host that relayed it —
/// the host deliberately holds no key material, so relaying is all it can do.
///
/// The signed fields and their canonical form must stay identical to
/// `verify_envelope_hmac` and to the extension's `signingInput`; the round-trip
/// test below and the extension's own verify test are what keep the three in step.
pub fn sign_envelope_hmac(
    message_id: &str,
    installation_id: &str,
    timestamp: &str,
    nonce: &str,
    payload: serde_json::Value,
    secret_b64url: &str,
) -> Option<serde_json::Value> {
    let signing_input = canonical_json(&serde_json::json!({
        "message_id": message_id,
        "installation_id": installation_id,
        "timestamp": timestamp,
        "nonce": nonce,
        "payload": payload,
    }));
    let key = base64url_decode(secret_b64url)?;
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&key).ok()?;
    mac.update(signing_input.as_bytes());
    Some(serde_json::json!({
        "message_id": message_id,
        "installation_id": installation_id,
        "timestamp": timestamp,
        "nonce": nonce,
        "payload": payload,
        "signature": hex::encode(mac.finalize().into_bytes()),
    }))
}

/// Converts a verified extension semantic shape into a full WorkflowEvent
/// JSON value for the standard ingest pipeline.
pub fn shape_to_workflow_event(
    shape: &serde_json::Value,
    identity: (&str, &str, &str),
    monotonic_ms: i64,
    occurred_at_iso: &str,
    event_id: &str,
) -> Option<serde_json::Value> {
    let event_type = shape.get("event_type")?.as_str()?;
    let domain = shape.get("domain")?.as_str()?;
    // Display name derives from the domain — the extension never sends titles.
    let display_name = domain.split('.').rev().nth(1).map(|s| {
        let mut c = s.chars();
        match c.next() {
            Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
            None => s.to_string(),
        }
    })?;
    Some(serde_json::json!({
        "schema_version": 1,
        "event_id": event_id,
        "device_id": identity.0,
        "user_id": identity.1,
        "organization_id": identity.2,
        "occurred_at": occurred_at_iso,
        "monotonic_ms": monotonic_ms,
        "source": "chrome",
        "app": { "display_name": display_name, "domain": domain },
        "event_type": event_type,
        "target": shape.get("target").cloned().unwrap_or(serde_json::json!({})),
        "context": shape.get("context").cloned().unwrap_or(serde_json::json!({})),
        "sensitivity": "internal",
        "redaction": { "applied": false, "reasons": [] }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SECRET: &str = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc"; // 32x 0x07 base64url

    #[test]
    fn base64url_round_trip() {
        let bytes = [7u8; 32];
        let encoded = base64url_encode(&bytes);
        assert_eq!(encoded, SECRET);
        assert_eq!(base64url_decode(&encoded).unwrap(), bytes.to_vec());
    }

    #[test]
    fn a_desktop_signed_envelope_verifies_and_a_tampered_one_does_not() {
        let envelope = sign_envelope_hmac(
            "msg-1",
            "install-1",
            "2026-08-05T12:00:00.000Z",
            "nonce-1",
            json!({"type": "browser_action_request", "request": {"step_id": "step-1"}}),
            SECRET,
        )
        .expect("signs");
        assert!(verify_envelope_hmac(&envelope, SECRET));

        // Changing the payload after signing must invalidate it — otherwise a relay
        // could swap the action for a different one on the way to the browser.
        let mut swapped = envelope.clone();
        swapped["payload"]["request"]["step_id"] = json!("step-2");
        assert!(!verify_envelope_hmac(&swapped, SECRET));

        // And a different secret must not verify it.
        assert!(!verify_envelope_hmac(
            &envelope,
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        ));
    }

    #[test]
    fn signing_covers_exactly_the_five_fields_the_extension_signs() {
        let envelope = sign_envelope_hmac(
            "msg-1",
            "install-1",
            "2026-08-05T12:00:00.000Z",
            "nonce-1",
            json!({"type": "browser_action_request"}),
            SECRET,
        )
        .expect("signs");
        // A field the extension does not sign must not change the signature, and the
        // envelope must carry nothing beyond the five signed fields plus signature.
        let mut keys: Vec<&str> = envelope.as_object().unwrap().keys().map(|k| k.as_str()).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "installation_id",
                "message_id",
                "nonce",
                "payload",
                "signature",
                "timestamp"
            ]
        );
    }

    /// DRIFT CONTRACT. The desktop signs these envelopes and the extension
    /// verifies them, in different languages. A change to canonical JSON or to the
    /// set of signed fields on either side breaks actuation with no other symptom,
    /// so both sides assert against the same committed fixture — and the fixture's
    /// signature was produced by a third, independent implementation, so agreement
    /// between them means the canonical form is genuinely pinned rather than two
    /// copies of the same mistake.
    ///
    /// A MISSING fixture must FAIL, not skip: skipping quietly is how the two
    /// implementations would be free to drift apart.
    #[test]
    fn envelope_signing_matches_the_committed_cross_language_fixture() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../domain/browser-envelope-conformance.json"
        );
        let raw = std::fs::read_to_string(path)
            .unwrap_or_else(|e| panic!("browser-envelope-conformance.json unreadable: {e}"));
        let fixture: serde_json::Value = serde_json::from_str(&raw).expect("fixture is JSON");
        let secret = fixture["secret_b64url"].as_str().expect("secret");
        let expected = &fixture["envelope"];

        // 1. The canonical string this implementation builds is byte-identical.
        let signed_fields = serde_json::json!({
            "message_id": expected["message_id"],
            "installation_id": expected["installation_id"],
            "timestamp": expected["timestamp"],
            "nonce": expected["nonce"],
            "payload": expected["payload"],
        });
        assert_eq!(
            canonical_json(&signed_fields),
            fixture["signing_input"].as_str().expect("signing_input"),
            "canonical JSON drifted from the fixture"
        );

        // 2. Re-signing the same inputs reproduces the same signature.
        let resigned = sign_envelope_hmac(
            expected["message_id"].as_str().unwrap(),
            expected["installation_id"].as_str().unwrap(),
            expected["timestamp"].as_str().unwrap(),
            expected["nonce"].as_str().unwrap(),
            expected["payload"].clone(),
            secret,
        )
        .expect("signs");
        assert_eq!(
            resigned["signature"], expected["signature"],
            "signature drifted from the fixture"
        );

        // 3. And the committed envelope verifies as-is.
        assert!(verify_envelope_hmac(expected, secret));
    }

    #[test]
    fn signing_refuses_a_malformed_secret_rather_than_producing_a_weak_signature() {
        assert!(sign_envelope_hmac("m", "i", "t", "n", json!({}), "not base64url!!!").is_none());
    }

    #[test]
    fn canonical_json_sorts_keys_recursively() {
        let value = json!({"b": 1, "a": {"d": 2, "c": [3, {"z": 1, "y": 2}]}});
        assert_eq!(
            canonical_json(&value),
            r#"{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}"#
        );
    }

    /// FROZEN cross-implementation vector generated by the extension's
    /// WebCrypto implementation (extensions/chrome/src/lib/signing.ts) with
    /// secret = 0x07 * 32. The same vector is asserted in the extension's
    /// test suite — if either side's canonicalization drifts, both fail.
    const CROSS_IMPL_SIGNATURE: &str =
        "7777ebe4a55d7bcf1318cd7f79fbb917d836c84c3cd1f996d923b2cb1baa5438";

    #[test]
    fn verifies_envelope_signed_by_the_extension_implementation() {
        let envelope = json!({
            "message_id": "m-1",
            "installation_id": "i-1",
            "timestamp": "2026-07-17T18:00:00.000Z",
            "nonce": "n-1",
            "payload": {"type": "semantic_event", "event": {"event_type": "navigation"}},
            "signature": CROSS_IMPL_SIGNATURE,
        });
        assert!(verify_envelope_hmac(&envelope, SECRET));
        // any mutation breaks it
        let mut tampered = envelope.clone();
        tampered["payload"]["event"]["event_type"] = json!("record_updated");
        assert!(!verify_envelope_hmac(&tampered, SECRET));
        // wrong secret breaks it
        assert!(!verify_envelope_hmac(&envelope, &base64url_encode(&[9u8; 32])));
    }

    #[test]
    fn shape_conversion_builds_a_valid_event_frame() {
        let shape = json!({
            "event_type": "record_opened",
            "target": {"role": "row", "stable_id_hash": "abc"},
            "context": {"object_type": "account"},
            "domain": "acme.lightning.force.com"
        });
        let event = shape_to_workflow_event(
            &shape,
            ("d", "u", "o"),
            100,
            "2026-07-17T18:00:00.000Z",
            "e1",
        )
        .unwrap();
        assert_eq!(event["source"], "chrome");
        assert_eq!(event["app"]["domain"], "acme.lightning.force.com");
        assert_eq!(event["event_type"], "record_opened");
        assert_eq!(event["target"]["stable_id_hash"], "abc");
    }

    #[test]
    fn shape_conversion_passes_url_derived_context_through() {
        // The extension's contextFromUrl emits object_type/page_type; both
        // must survive into the stored WorkflowEvent context untouched.
        let shape = json!({
            "event_type": "navigation",
            "target": {},
            "context": {"object_type": "account", "page_type": "record"},
            "domain": "acme.lightning.force.com"
        });
        let event = shape_to_workflow_event(
            &shape,
            ("d", "u", "o"),
            100,
            "2026-07-17T18:00:00.000Z",
            "e2",
        )
        .unwrap();
        assert_eq!(event["context"]["object_type"], "account");
        assert_eq!(event["context"]["page_type"], "record");

        // Older extensions that still send an empty context stay valid.
        let bare = json!({
            "event_type": "navigation",
            "target": {},
            "context": {},
            "domain": "acme.lightning.force.com"
        });
        let event = shape_to_workflow_event(
            &bare,
            ("d", "u", "o"),
            100,
            "2026-07-17T18:00:00.000Z",
            "e3",
        )
        .unwrap();
        assert_eq!(event["context"], json!({}));
    }

    #[test]
    fn pairing_token_hashing_is_one_way() {
        let token = "some-one-time-token";
        let hash = sha256_hex(token.as_bytes());
        assert_eq!(hash.len(), 64);
        assert_ne!(hash, token);
        assert_eq!(hash, sha256_hex(token.as_bytes()));
    }
}
