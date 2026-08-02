//! Domain-pack engine (L1) — the PRODUCTION classifier.
//!
//! Classification must run on-device, post-redaction and pre-storage, which is
//! this crate's ingest path — so this is where it lives. `@maman/domain-packs`
//! holds the same algorithm in TypeScript as the readable specification and
//! test oracle; `domain/classifier-conformance.json` is a shared fixture that
//! BOTH implementations must satisfy, so the two cannot silently drift.
//!
//! Packs are read as compiled JSON (`pnpm packs:generate`), so no YAML parser
//! is needed here and nothing is added to the dependency-free observer.
//!
//! Two invariants:
//! - Never force a mapping. No match yields `None` and the event stays
//!   unclassified rather than being coerced into a domain.
//! - Label text never reaches this process. Callers pass the label PATTERNS
//!   that matched inside the observer, never the text they matched against.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Clone, Deserialize, Default)]
pub struct DetectionHints {
    #[serde(default)]
    pub app_categories: Vec<String>,
    #[serde(default)]
    pub label_patterns: Vec<String>,
    #[serde(default)]
    pub target_roles: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PackObject {
    pub id: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub detection_hints: DetectionHints,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PackAction {
    pub id: String,
    pub risk: String,
    #[serde(default)]
    pub on: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PackWorkflow {
    pub id: String,
    pub name: String,
    pub cadence: String,
    pub signature: Vec<Vec<String>>,
    #[serde(default = "default_min_reps")]
    pub min_reps_with_template: u32,
}

fn default_min_reps() -> u32 {
    2
}

#[derive(Debug, Clone, Deserialize)]
pub struct DomainPack {
    pub domain: String,
    pub version: String,
    pub objects: Vec<PackObject>,
    pub actions: Vec<PackAction>,
    pub workflows: Vec<PackWorkflow>,
}

/// The classification attached to an event. Mirrors `domainClassification` in
/// @maman/contracts; ids are pack taxonomy ids, never free text.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Classification {
    pub domain: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub object: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
    pub confidence: f64,
}

/// Privacy-safe view of an event, as the ingest path sees it.
#[derive(Debug, Default, Clone, Deserialize)]
pub struct ClassifierInput {
    #[serde(default)]
    pub app_category: Option<String>,
    pub event_type: String,
    #[serde(default)]
    pub target_role: Option<String>,
    #[serde(default)]
    pub semantic_type: Option<String>,
    #[serde(default)]
    pub object_type: Option<String>,
    /// Pattern strings that matched inside the observer — never label text.
    #[serde(default)]
    pub label_pattern_hits: Vec<String>,
}

// Evidence weights — must match packages/domain-packs/src/classify.ts.
const W_LABEL_HIT: f64 = 0.45;
const W_APP_CATEGORY: f64 = 0.3;
const W_OBJECT_TYPE_MATCH: f64 = 0.4;
const W_ROLE_HIT: f64 = 0.15;
const W_SEMANTIC_HINT: f64 = 0.2;
const W_ACTION_BONUS: f64 = 0.1;

fn is_write_event(event_type: &str) -> bool {
    matches!(
        event_type,
        "value_committed" | "record_updated" | "paste_semantic" | "table_exported"
    )
}

fn is_read_event(event_type: &str) -> bool {
    matches!(
        event_type,
        "record_opened"
            | "table_read"
            | "navigation"
            | "element_focused"
            | "element_activated"
            | "app_activated"
            | "window_focused"
            | "copy_semantic"
    )
}

fn risk_rank(risk: &str) -> usize {
    match risk {
        "none" => 0,
        "low" => 1,
        "medium" => 2,
        "high" => 3,
        _ => 4,
    }
}

/// Loads every compiled pack (`*.json`) from a directory, sorted by domain id so
/// classification is deterministic regardless of filesystem order.
pub fn load_packs(dir: &Path) -> Vec<DomainPack> {
    let mut packs: Vec<DomainPack> = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return packs;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        // A malformed pack is skipped, never fatal: observation must keep working.
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(pack) = serde_json::from_str::<DomainPack>(&text) {
                packs.push(pack);
            }
        }
    }
    packs.sort_by(|a, b| a.domain.cmp(&b.domain));
    packs
}

/// Every distinct label pattern across packs, for pushing to the observer's
/// `configure` control line. Sorted + deduped so the pushed config is stable.
pub fn label_patterns(packs: &[DomainPack]) -> Vec<String> {
    let mut out: Vec<String> = packs
        .iter()
        .flat_map(|p| p.objects.iter())
        .flat_map(|o| o.detection_hints.label_patterns.iter().cloned())
        .collect();
    out.sort();
    out.dedup();
    out
}

fn choose_action<'a>(
    pack: &'a DomainPack,
    object_id: &str,
    event_type: &str,
) -> Option<&'a PackAction> {
    let applicable: Vec<&PackAction> = pack
        .actions
        .iter()
        .filter(|a| a.on.is_empty() || a.on.iter().any(|o| o == "*" || o == object_id))
        .collect();
    if applicable.is_empty() {
        return None;
    }

    let write = is_write_event(event_type);
    let read = is_read_event(event_type);
    // A read must never be classified as a mutating action.
    let eligible: Vec<&PackAction> = applicable
        .into_iter()
        .filter(|a| {
            if write {
                a.risk != "none"
            } else if read {
                a.risk == "none" || a.risk == "low"
            } else {
                true
            }
        })
        .collect();
    if eligible.is_empty() {
        return None;
    }
    // Lowest-risk plausible action, tie-broken by id: classification never
    // inflates risk, and policy re-derives risk from the pack anyway.
    eligible
        .into_iter()
        .min_by(|a, b| risk_rank(&a.risk).cmp(&risk_rank(&b.risk)).then(a.id.cmp(&b.id)))
}

/// Classifies one event. `None` means unclassified — callers must leave it so.
pub fn classify_event(packs: &[DomainPack], input: &ClassifierInput) -> Option<Classification> {
    let mut best: Option<Classification> = None;

    for pack in packs {
        // Score objects, then take the strongest (ties broken by id).
        let mut scored: Vec<(&PackObject, f64)> = Vec::new();
        for object in &pack.objects {
            let mut score = 0.0;
            // App category is CONTEXT, not identification: on its own it must
            // never classify. At least one identifying signal is required —
            // mirrors packages/domain-packs/src/classify.ts exactly.
            let mut identified = false;
            let hints = &object.detection_hints;
            let names: Vec<&String> = std::iter::once(&object.id).chain(object.aliases.iter()).collect();

            if let Some(object_type) = &input.object_type {
                if names.iter().any(|n| *n == object_type) {
                    score += W_OBJECT_TYPE_MATCH;
                    identified = true;
                }
            }
            if let Some(semantic) = &input.semantic_type {
                if names.iter().any(|n| semantic.contains(n.as_str())) {
                    score += W_SEMANTIC_HINT;
                    identified = true;
                }
            }
            if hints
                .label_patterns
                .iter()
                .any(|p| input.label_pattern_hits.contains(p))
            {
                score += W_LABEL_HIT;
                identified = true;
            }
            if let Some(category) = &input.app_category {
                if hints.app_categories.contains(category) {
                    score += W_APP_CATEGORY;
                }
            }
            if let Some(role) = &input.target_role {
                if hints.target_roles.contains(role) {
                    score += W_ROLE_HIT;
                    identified = true;
                }
            }
            if identified && score > 0.0 {
                scored.push((object, score));
            }
        }
        if scored.is_empty() {
            continue;
        }
        scored.sort_by(|a, b| {
            b.1.partial_cmp(&a.1)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(a.0.id.cmp(&b.0.id))
        });
        let (object, object_score) = scored[0];
        let action = choose_action(pack, &object.id, &input.event_type);

        let raw = object_score + if action.is_some() { W_ACTION_BONUS } else { 0.0 };
        // Round to 4dp then clamp, matching the TS implementation exactly.
        let confidence = ((raw * 10_000.0).round() / 10_000.0).min(1.0);
        let candidate = Classification {
            domain: pack.domain.clone(),
            object: Some(object.id.clone()),
            action: action.map(|a| a.id.clone()),
            confidence,
        };
        if best
            .as_ref()
            .map(|b| candidate.confidence > b.confidence)
            .unwrap_or(true)
        {
            best = Some(candidate);
        }
    }
    best
}

/// Per-domain summary for the `packs_status` command.
#[derive(Debug, Serialize)]
pub struct PackStatus {
    pub domain: String,
    pub version: String,
    pub object_count: usize,
    pub action_count: usize,
    pub workflow_count: usize,
}

pub fn pack_status(packs: &[DomainPack]) -> Vec<PackStatus> {
    packs
        .iter()
        .map(|p| PackStatus {
            domain: p.domain.clone(),
            version: p.version.clone(),
            object_count: p.objects.len(),
            action_count: p.actions.len(),
            workflow_count: p.workflows.len(),
        })
        .collect()
}

/// Builds the classifier input from a stored event payload + its app category.
/// Label hits come from the payload only if the observer put them there; this
/// process never sees label text.
pub fn input_from_payload(payload: &serde_json::Value, app_category: &str) -> ClassifierInput {
    let s = |ptr: &str| {
        payload
            .pointer(ptr)
            .and_then(|v| v.as_str())
            .map(|v| v.to_string())
    };
    ClassifierInput {
        app_category: Some(app_category.to_string()),
        event_type: s("/event_type").unwrap_or_default(),
        target_role: s("/target/role"),
        semantic_type: s("/target/semantic_type"),
        object_type: s("/context/object_type"),
        label_pattern_hits: payload
            .pointer("/target/label_pattern_hits")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default(),
    }
}

/// Conformance cases shared with the TypeScript implementation.
#[derive(Debug, Deserialize)]
pub struct ConformanceCase {
    pub name: String,
    pub input: ClassifierInput,
    pub expected: Option<BTreeMap<String, serde_json::Value>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn packs_dir() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../domain/packs")
            .canonicalize()
            .expect("domain/packs must exist")
    }

    fn packs() -> Vec<DomainPack> {
        let packs = load_packs(&packs_dir());
        assert!(!packs.is_empty(), "compiled packs must load");
        packs
    }

    #[test]
    fn loads_compiled_packs_sorted_by_domain() {
        let packs = packs();
        let domains: Vec<&str> = packs.iter().map(|p| p.domain.as_str()).collect();
        let mut sorted = domains.clone();
        sorted.sort_unstable();
        assert_eq!(domains, sorted);
        assert!(domains.contains(&"finops"));
        assert!(domains.contains(&"revops"));
    }

    #[test]
    fn a_missing_or_malformed_pack_directory_never_panics() {
        assert!(load_packs(std::path::Path::new("/nonexistent/packs")).is_empty());
    }

    #[test]
    fn unmatched_events_stay_unclassified() {
        let input = ClassifierInput {
            app_category: Some("other".into()),
            event_type: "app_activated".into(),
            ..Default::default()
        };
        assert!(classify_event(&packs(), &input).is_none());
    }

    #[test]
    fn a_read_event_is_never_classified_as_a_mutating_action() {
        let input = ClassifierInput {
            event_type: "record_opened".into(),
            object_type: Some("invoice".into()),
            ..Default::default()
        };
        let result = classify_event(&packs(), &input).expect("should classify");
        let pack = packs().into_iter().find(|p| p.domain == result.domain).unwrap();
        if let Some(action_id) = &result.action {
            let action = pack.actions.iter().find(|a| &a.id == action_id).unwrap();
            assert!(
                action.risk == "none" || action.risk == "low",
                "read event classified as {} (risk {})",
                action.id,
                action.risk
            );
        }
    }

    #[test]
    fn label_patterns_are_collected_deduped_for_the_observer() {
        let patterns = label_patterns(&packs());
        assert!(!patterns.is_empty());
        let mut deduped = patterns.clone();
        deduped.dedup();
        assert_eq!(patterns, deduped, "must be sorted + deduped");
        // Pattern strings only — never label text or hashes.
        assert!(patterns.iter().all(|p| !p.is_empty()));
    }

    #[test]
    fn pack_status_reports_counts_per_domain() {
        let status = pack_status(&packs());
        assert_eq!(status.len(), 2);
        assert!(status.iter().all(|s| s.workflow_count > 0));
    }

    /// The anti-drift test: both implementations must agree on every case in
    /// domain/classifier-conformance.json. The TS suite asserts the same file.
    #[test]
    fn matches_the_typescript_classifier_on_every_conformance_case() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../domain/classifier-conformance.json");
        let text = std::fs::read_to_string(&path).expect("conformance fixture must exist");
        let cases: Vec<ConformanceCase> =
            serde_json::from_str(&text).expect("conformance fixture must parse");
        assert!(!cases.is_empty());
        let packs = packs();

        for case in cases {
            let actual = classify_event(&packs, &case.input);
            match (&case.expected, &actual) {
                (None, None) => {}
                (Some(expected), Some(actual)) => {
                    assert_eq!(
                        expected.get("domain").and_then(|v| v.as_str()),
                        Some(actual.domain.as_str()),
                        "case {}: domain",
                        case.name
                    );
                    assert_eq!(
                        expected.get("object").and_then(|v| v.as_str()),
                        actual.object.as_deref(),
                        "case {}: object",
                        case.name
                    );
                    assert_eq!(
                        expected.get("action").and_then(|v| v.as_str()),
                        actual.action.as_deref(),
                        "case {}: action",
                        case.name
                    );
                    let want = expected.get("confidence").and_then(|v| v.as_f64()).unwrap();
                    assert!(
                        (want - actual.confidence).abs() < 1e-9,
                        "case {}: confidence {} != {}",
                        case.name,
                        actual.confidence,
                        want
                    );
                }
                (expected, actual) => panic!(
                    "case {}: expected {:?} but got {:?}",
                    case.name, expected, actual
                ),
            }
        }
    }
}
