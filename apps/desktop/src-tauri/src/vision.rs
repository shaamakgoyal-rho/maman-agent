//! Teach Mode vision egress — the only place in this product where PIXELS leave
//! the device.
//!
//! It lives in the Rust core for the same reason every other outbound request
//! does: the Swift observer contains no network code by design (CI greps for it),
//! and the webview may not talk HTTP (a structural test greps for that too). So
//! frames travel observer → core → API, and this module is that last hop.
//!
//! WHAT THIS MODULE MAY AND MAY NOT DO
//!
//! - It NEVER decides whether a frame may be sent. That decision is made by the
//!   egress gate in the observer, before the pixels crossed the pipe, and mirrored
//!   in TypeScript with a fixture pinning the two. By the time bytes arrive here
//!   they are already masked and already cleared.
//! - It NEVER writes pixels anywhere: no disk, no log, no database, no error
//!   string. `redacted_debug` exists so a failure can be reported without the
//!   frame riding along in a log line.
//! - Model output is UNTRUSTED. This module returns raw JSON and does not
//!   interpret it; `@maman/teach-mode`'s `interpretVisionResponse` parses it
//!   against the strict schema and drops anything below the confidence floor.
//! - The model id comes from configuration, never from source (project rule).

use serde_json::Value;

/// Anthropic's messages endpoint. The only host this module ever contacts.
const ANTHROPIC_MESSAGES_URL: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";

/// Cap on one frame's base64 payload (~8 MB of JPEG). A frame larger than this is
/// dropped rather than sent: the observer downscales to 1400px, so anything this
/// big means something upstream is wrong, and "wrong" plus "pixels" plus
/// "outbound" is not a combination worth proceeding through.
pub const MAX_FRAME_B64_BYTES: usize = 8 * 1024 * 1024;

/// The instruction sent with every frame.
///
/// Two things it deliberately does NOT ask for: any judgement about whether the
/// work is automatable, risky or valuable (the schema has nowhere to put those,
/// and they stay deterministic), and any transcription of field CONTENTS. It asks
/// for labels and kinds, which is what a canonical event is made of.
pub const VISION_SYSTEM_PROMPT: &str = concat!(
    "You are looking at one screenshot of a business application, captured while a ",
    "person demonstrated a repetitive workflow they perform by hand. Parts of the ",
    "image may be blacked out; that is deliberate redaction — never speculate about ",
    "what was behind a black rectangle.\n\n",
    "Report ONLY the discrete user actions this frame shows evidence of. Reply with ",
    "JSON matching exactly this shape and nothing else:\n",
    "{\"schema_version\":1,\"frame_id\":\"<echo>\",\"session_id\":\"<echo>\",",
    "\"actions\":[{\"event_type\":\"...\",\"target_role\":\"...\",\"semantic_type\":\"...\",",
    "\"object_type\":\"...\",\"label\":\"...\",\"confidence\":0.0}],\"uncertain\":false}\n\n",
    "event_type is one of: app_activated, window_focused, element_focused, ",
    "element_activated, value_committed, navigation, record_opened, record_updated, ",
    "table_read, table_exported, copy_semantic, paste_semantic, boundary_redacted, ",
    "idle_started, idle_ended.\n",
    "target_role is one of: field, button, row, cell, menu, tab, link, list, ",
    "document, unknown.\n",
    "semantic_type is one of: date, amount, percent, name, identifier, status, ",
    "email, url, text, unknown.\n",
    "object_type is a lowercase snake_case business noun (invoice, account, ",
    "opportunity) or omitted.\n",
    "label is the control's VISIBLE LABEL — never the value inside it, never text ",
    "the user typed, never anything that looks like a password, key or token.\n",
    "confidence is your honest 0..1 certainty that this action actually occurred.\n\n",
    "If the frame shows no discrete action, return an empty actions array. If you ",
    "cannot tell what is happening, set uncertain to true. An honest \"I could not ",
    "tell\" is far more useful than a guess: a wrong reading teaches this system a ",
    "workflow the person never performed."
);

/// Tokens one call consumed, as the API reported them.
///
/// Reported rather than estimated: the estimate shown to the user before a session
/// is arithmetic over an assumed reply size, and the only way to know whether that
/// assumption holds is to compare it against what actually came back.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct FrameUsage {
    pub input_tokens: u32,
    pub output_tokens: u32,
    /// Input tokens served from the prompt cache, billed at a fraction.
    pub cache_read_tokens: u32,
}

/// One frame's answer plus what it cost.
#[derive(Debug, Clone, PartialEq)]
pub struct FrameOutcome {
    pub observation: Value,
    pub usage: FrameUsage,
}

/// Everything needed for one vision call, assembled by the caller.
pub struct FrameRequest<'a> {
    pub frame_id: &'a str,
    pub session_id: &'a str,
    /// Base64 JPEG. Already masked and already cleared by the observer's gate.
    pub jpeg_b64: &'a str,
    pub api_key: &'a str,
    /// From configuration (`MAMAN_VISION_MODEL`), never hardcoded here.
    pub model: &'a str,
}

/// Why a frame was not sent, or its answer not usable. Strings are safe to log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VisionError {
    /// No API key configured — Teach Mode cannot infer anything.
    NotConfigured,
    /// Payload above `MAX_FRAME_B64_BYTES`, or empty.
    FrameTooLarge,
    /// Transport failure. Carries a REDACTED description, never a frame.
    Transport(String),
    /// Non-2xx from the API, with the status only.
    Status(u16),
    /// 2xx whose body was not the JSON object shape we asked for.
    Malformed(String),
}

impl std::fmt::Display for VisionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VisionError::NotConfigured => write!(f, "no vision model configured"),
            VisionError::FrameTooLarge => write!(f, "frame payload rejected by size gate"),
            VisionError::Transport(e) => write!(f, "vision transport failed: {e}"),
            VisionError::Status(code) => write!(f, "vision API returned status {code}"),
            VisionError::Malformed(e) => write!(f, "vision response malformed: {e}"),
        }
    }
}

/// Builds the request body for one frame.
///
/// Pure and separately tested, because the alternative — asserting the body shape
/// only by making a real API call — is how a frame ends up somewhere unintended.
pub fn build_request_body(request: &FrameRequest<'_>) -> Value {
    serde_json::json!({
        "model": request.model,
        // Enough for a handful of actions and no more; a runaway response costs
        // money and cannot help, since the schema caps actions at 8.
        // A cap, not a target: billing is on tokens actually produced, and a reply
        // is one small JSON object. Modelling the cost AT this cap overstated a
        // 15-minute session by roughly 8x, which is why the estimate in
        // `@maman/teach-mode`'s cost module uses a measured reply size instead.
        "max_tokens": 1024,
        // CACHED, because this prompt is byte-identical on every frame of every
        // session: a 15-minute session at 2.5s would otherwise re-send ~445 tokens
        // 360 times. Worth having in place before the first real call rather than
        // discovered on a bill. It is ~14% of the cost, though — the IMAGE is about
        // 80% of each request, so frame size is the lever that actually matters.
        "system": [{
            "type": "text",
            "text": VISION_SYSTEM_PROMPT,
            "cache_control": { "type": "ephemeral" }
        }],
        "messages": [{
            "role": "user",
            "content": [
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/jpeg",
                        "data": request.jpeg_b64,
                    }
                },
                {
                    "type": "text",
                    // The ids are echoed back and CHECKED by the interpreter, so a
                    // mixed-up batch cannot be attributed to the wrong frame.
                    "text": format!(
                        "frame_id={} session_id={}\nReply with JSON only.",
                        request.frame_id, request.session_id
                    ),
                }
            ]
        }]
    })
}

/// Rejects a frame before it can reach the network. Size only — the SAFETY
/// decision already happened in the observer's gate.
pub fn check_frame_size(jpeg_b64: &str) -> Result<(), VisionError> {
    if jpeg_b64.is_empty() || jpeg_b64.len() > MAX_FRAME_B64_BYTES {
        return Err(VisionError::FrameTooLarge);
    }
    Ok(())
}

/// Pulls the model's text out of an Anthropic response and parses it as JSON.
///
/// Tolerates the model wrapping JSON in a ```json fence, because that is a
/// formatting quirk rather than a semantic failure — but does NOT tolerate
/// anything else. What comes back here goes to a strict Zod parse; this only has
/// to hand over something that is JSON at all.
/// Usage from a response body. Absent fields read as zero rather than failing:
/// a missing count is a reporting gap, not a reason to discard a good answer.
pub fn extract_usage(body: &Value) -> FrameUsage {
    let n = |path: &str| -> u32 {
        body.pointer(path).and_then(|v| v.as_u64()).unwrap_or(0).min(u32::MAX as u64) as u32
    };
    FrameUsage {
        input_tokens: n("/usage/input_tokens"),
        output_tokens: n("/usage/output_tokens"),
        cache_read_tokens: n("/usage/cache_read_input_tokens"),
    }
}

pub fn extract_observation(body: &Value) -> Result<Value, VisionError> {
    let text = body
        .get("content")
        .and_then(|c| c.as_array())
        .and_then(|items| {
            items
                .iter()
                .filter(|item| item.get("type").and_then(|t| t.as_str()) == Some("text"))
                .find_map(|item| item.get("text").and_then(|t| t.as_str()))
        })
        .ok_or_else(|| VisionError::Malformed("no text content in response".into()))?;

    let trimmed = strip_code_fence(text.trim());
    serde_json::from_str::<Value>(trimmed)
        .map_err(|e| VisionError::Malformed(format!("not JSON: {e}")))
        .and_then(|v| {
            if v.is_object() {
                Ok(v)
            } else {
                Err(VisionError::Malformed("not a JSON object".into()))
            }
        })
}

fn strip_code_fence(text: &str) -> &str {
    let without_open = text
        .strip_prefix("```json")
        .or_else(|| text.strip_prefix("```"))
        .unwrap_or(text);
    without_open.trim().strip_suffix("```").unwrap_or(without_open).trim()
}

/// Describes a transport error WITHOUT the frame.
///
/// reqwest's Display can include the request URL but never a body; even so this
/// keeps only the shape of the failure, because an error string is the one place a
/// payload most easily leaks into a log.
pub fn redacted_debug(error: &reqwest::Error) -> String {
    let kind = if error.is_timeout() {
        "timeout"
    } else if error.is_connect() {
        "connect"
    } else if error.is_decode() {
        "decode"
    } else if error.is_body() {
        "body"
    } else {
        "request"
    };
    format!("{kind} error contacting the vision API")
}

/// Sends one frame and returns the model's raw JSON answer.
///
/// The caller interprets it; this function forms no opinion about what it means.
pub async fn infer_frame(
    client: &reqwest::Client,
    request: FrameRequest<'_>,
) -> Result<FrameOutcome, VisionError> {
    if request.api_key.is_empty() || request.model.is_empty() {
        return Err(VisionError::NotConfigured);
    }
    check_frame_size(request.jpeg_b64)?;

    let response = client
        .post(ANTHROPIC_MESSAGES_URL)
        .header("x-api-key", request.api_key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("content-type", "application/json")
        .json(&build_request_body(&request))
        .send()
        .await
        .map_err(|e| VisionError::Transport(redacted_debug(&e)))?;

    let status = response.status();
    if !status.is_success() {
        // The body is deliberately NOT read into the error: an API error body can
        // echo request content, and request content here is a picture of the
        // user's screen.
        return Err(VisionError::Status(status.as_u16()));
    }

    let body = response
        .json::<Value>()
        .await
        .map_err(|e| VisionError::Transport(redacted_debug(&e)))?;
    Ok(FrameOutcome {
        observation: extract_observation(&body)?,
        usage: extract_usage(&body),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request<'a>(jpeg: &'a str) -> FrameRequest<'a> {
        FrameRequest {
            frame_id: "f1",
            session_id: "s1",
            jpeg_b64: jpeg,
            api_key: "test-key",
            model: "claude-test-model",
        }
    }

    #[test]
    fn the_request_body_carries_the_frame_and_echoes_the_ids() {
        let body = build_request_body(&request("/9j/4AAQ"));
        assert_eq!(body["model"], "claude-test-model");
        assert_eq!(body["messages"][0]["content"][0]["source"]["data"], "/9j/4AAQ");
        assert_eq!(body["messages"][0]["content"][0]["source"]["media_type"], "image/jpeg");
        let text = body["messages"][0]["content"][1]["text"].as_str().unwrap();
        assert!(text.contains("frame_id=f1"), "{text}");
        assert!(text.contains("session_id=s1"), "{text}");
    }

    #[test]
    fn the_model_id_is_never_hardcoded_in_this_module() {
        // Project rule: model names come from configuration, not source. The body
        // must echo whatever it was given, and the prompt must name no model.
        let body = build_request_body(&request("x"));
        assert_eq!(body["model"], "claude-test-model");
        assert!(!VISION_SYSTEM_PROMPT.contains("claude-"), "prompt names a model");
    }

    #[test]
    fn the_prompt_asks_for_labels_and_forbids_values() {
        assert!(VISION_SYSTEM_PROMPT.contains("VISIBLE LABEL"));
        assert!(VISION_SYSTEM_PROMPT.contains("never the value inside it"));
        assert!(VISION_SYSTEM_PROMPT.contains("never anything that looks like a password"));
        // It must not invite the model to speculate behind a mask.
        assert!(VISION_SYSTEM_PROMPT.contains("never speculate"));
    }

    #[test]
    fn the_prompt_asks_for_no_judgement_the_model_is_not_allowed_to_make() {
        // The schema has nowhere to put these; the prompt must not solicit them
        // either, or the model wastes tokens being refused.
        for forbidden in ["risk", "automat", "eligib", "minutes saved", "worth"] {
            assert!(
                !VISION_SYSTEM_PROMPT.to_lowercase().contains(forbidden),
                "prompt solicits {forbidden}"
            );
        }
    }

    #[test]
    fn the_prompt_prefers_an_honest_i_cannot_tell_over_a_guess() {
        assert!(VISION_SYSTEM_PROMPT.contains("uncertain to true"));
        assert!(VISION_SYSTEM_PROMPT.contains("workflow the person never performed"));
    }

    #[test]
    fn an_oversized_or_empty_frame_is_refused_before_the_network() {
        assert_eq!(check_frame_size(""), Err(VisionError::FrameTooLarge));
        let huge = "a".repeat(MAX_FRAME_B64_BYTES + 1);
        assert_eq!(check_frame_size(&huge), Err(VisionError::FrameTooLarge));
        assert_eq!(check_frame_size(&"a".repeat(1024)), Ok(()));
    }

    #[test]
    fn extracts_the_json_object_the_model_returned() {
        let body = serde_json::json!({
            "content": [{"type": "text", "text": r#"{"schema_version":1,"actions":[]}"#}]
        });
        let observation = extract_observation(&body).expect("extracts");
        assert_eq!(observation["schema_version"], 1);
    }

    #[test]
    fn tolerates_a_code_fence_but_not_anything_else() {
        for wrapped in [
            "```json\n{\"a\":1}\n```",
            "```\n{\"a\":1}\n```",
            "  {\"a\":1}  ",
        ] {
            let body = serde_json::json!({"content": [{"type": "text", "text": wrapped}]});
            assert_eq!(extract_observation(&body).expect(wrapped)["a"], 1);
        }
        for bad in ["not json at all", "[1,2,3]", "\"a string\"", "42"] {
            let body = serde_json::json!({"content": [{"type": "text", "text": bad}]});
            assert!(matches!(
                extract_observation(&body),
                Err(VisionError::Malformed(_))
            ), "should reject: {bad}");
        }
    }

    #[test]
    fn a_response_with_no_text_content_is_malformed_not_a_panic() {
        for body in [
            serde_json::json!({}),
            serde_json::json!({"content": []}),
            serde_json::json!({"content": [{"type": "tool_use"}]}),
            serde_json::json!({"content": "text"}),
        ] {
            assert!(matches!(
                extract_observation(&body),
                Err(VisionError::Malformed(_))
            ));
        }
    }

    #[tokio::test]
    async fn no_api_key_or_model_means_no_request_is_attempted() {
        let client = reqwest::Client::new();
        let mut request = request("/9j/4AAQ");
        request.api_key = "";
        assert_eq!(infer_frame(&client, request).await, Err(VisionError::NotConfigured));

        let mut request = self::request("/9j/4AAQ");
        request.model = "";
        assert_eq!(infer_frame(&client, request).await, Err(VisionError::NotConfigured));
    }

    #[test]
    fn the_system_prompt_is_sent_as_a_cached_block() {
        // Byte-identical on every frame of every session: a 15-minute session would
        // otherwise re-send it 360 times.
        let body = build_request_body(&request("x"));
        let system = body["system"].as_array().expect("system is a block array");
        assert_eq!(system.len(), 1);
        assert_eq!(system[0]["type"], "text");
        assert_eq!(system[0]["cache_control"]["type"], "ephemeral");
        assert_eq!(system[0]["text"], VISION_SYSTEM_PROMPT);
    }

    #[test]
    fn usage_is_read_from_the_response_and_missing_counts_are_zero() {
        let body = serde_json::json!({
            "usage": {
                "input_tokens": 2187,
                "output_tokens": 128,
                "cache_read_input_tokens": 445
            }
        });
        assert_eq!(
            extract_usage(&body),
            FrameUsage { input_tokens: 2187, output_tokens: 128, cache_read_tokens: 445 }
        );
        // A reporting gap is not a reason to discard an otherwise good answer.
        assert_eq!(extract_usage(&serde_json::json!({})), FrameUsage::default());
        assert_eq!(
            extract_usage(&serde_json::json!({"usage": {"input_tokens": 10}})),
            FrameUsage { input_tokens: 10, output_tokens: 0, cache_read_tokens: 0 }
        );
    }

    #[test]
    fn a_successful_call_reports_both_the_answer_and_what_it_cost() {
        // The two travel together so a session can compare estimate against actual;
        // an estimate nobody checks is a guess with a decimal point.
        let body = serde_json::json!({
            "content": [{"type": "text", "text": r#"{"schema_version":1,"actions":[]}"#}],
            "usage": {"input_tokens": 2187, "output_tokens": 128}
        });
        let observation = extract_observation(&body).expect("extracts");
        let usage = extract_usage(&body);
        let outcome = FrameOutcome { observation, usage };
        assert_eq!(outcome.observation["schema_version"], 1);
        assert_eq!(outcome.usage.input_tokens, 2187);
    }

    #[test]
    fn error_display_never_contains_frame_bytes() {
        // Whatever goes wrong, the message must be safe to write to a log.
        let messages = [
            VisionError::NotConfigured.to_string(),
            VisionError::FrameTooLarge.to_string(),
            VisionError::Transport("timeout error contacting the vision API".into()).to_string(),
            VisionError::Status(429).to_string(),
            VisionError::Malformed("not JSON".into()).to_string(),
        ];
        for message in messages {
            assert!(!message.contains("/9j/"), "{message}");
            assert!(!message.contains("base64"), "{message}");
        }
    }
}
