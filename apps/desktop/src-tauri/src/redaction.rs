//! Defense-in-depth redaction checks applied before any event is persisted.
//! The observer and extension redact at the source; this module guarantees
//! that nothing forbidden can reach the local store even if they fail.

use serde_json::Value;

/// Field names that must never appear anywhere inside a stored event payload.
pub const FORBIDDEN_FIELDS: &[&str] = &[
    "value",
    "text",
    "password",
    "token",
    "cookie",
    "secret",
    "body",
    "clipboard",
    "keystrokes",
    "key_code",
    "screenshot",
];

/// Hard deny list (spec §10): contexts that must never be observed.
/// Matched against app display names, bundle ids, and domains, lowercased.
pub const HARD_DENY_SUBSTRINGS: &[&str] = &[
    // password managers
    "1password",
    "lastpass",
    "bitwarden",
    "dashlane",
    "keeper",
    "keychain access",
    "com.apple.keychainaccess",
    // system auth surfaces
    "loginwindow",
    "securityagent",
    // banking / payments (common consumer + payroll)
    "chase.com",
    "bankofamerica.com",
    "wellsfargo.com",
    "citi.com",
    "paypal.com",
    "venmo.com",
    "wise.com",
    "stripe.com/dashboard",
    // health portals
    "mychart",
    "healthcare.gov",
    "kaiserpermanente.org",
];

/// Returns the first forbidden field name found anywhere in the payload.
pub fn find_forbidden_field(payload: &Value) -> Option<String> {
    match payload {
        Value::Object(map) => {
            for (key, val) in map {
                let lower = key.to_lowercase();
                if FORBIDDEN_FIELDS.contains(&lower.as_str()) {
                    return Some(key.clone());
                }
                if let Some(found) = find_forbidden_field(val) {
                    return Some(found);
                }
            }
            None
        }
        Value::Array(items) => items.iter().find_map(find_forbidden_field),
        _ => None,
    }
}

/// True when the app identity (name, bundle id, or domain) is hard-denied.
pub fn is_hard_denied(identity: &str) -> bool {
    let lower = identity.to_lowercase();
    HARD_DENY_SUBSTRINGS.iter().any(|deny| lower.contains(deny))
}

/// True when the user marked this identity private (case-insensitive match).
pub fn is_user_denied(identity: &str, private_list: &[String]) -> bool {
    let lower = identity.to_lowercase();
    private_list.iter().any(|p| {
        let p = p.to_lowercase();
        !p.is_empty() && (lower == p || lower.contains(&p))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn finds_forbidden_fields_at_any_depth() {
        assert_eq!(
            find_forbidden_field(&json!({"a": {"b": {"password": "x"}}})),
            Some("password".into())
        );
        assert_eq!(
            find_forbidden_field(&json!({"items": [{"clipboard": "raw"}]})),
            Some("clipboard".into())
        );
        assert_eq!(find_forbidden_field(&json!({"Token": 1})), Some("Token".into()));
    }

    #[test]
    fn passes_clean_payloads() {
        assert_eq!(
            find_forbidden_field(&json!({
                "event_type": "record_opened",
                "target": {"role": "row", "stable_id_hash": "abc"}
            })),
            None
        );
    }

    #[test]
    fn hard_denies_password_managers_and_banking() {
        assert!(is_hard_denied("1Password 8"));
        assert!(is_hard_denied("com.apple.keychainaccess"));
        assert!(is_hard_denied("www.chase.com"));
        assert!(!is_hard_denied("Salesforce"));
        assert!(!is_hard_denied("docs.google.com"));
    }

    #[test]
    fn user_deny_list_matches_case_insensitively() {
        let list = vec!["Figma".to_string(), "internal.example.com".to_string()];
        assert!(is_user_denied("figma", &list));
        assert!(is_user_denied("app.internal.example.com", &list));
        assert!(!is_user_denied("Salesforce", &list));
    }
}
