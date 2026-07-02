//! OpenAI-compatible chat client (Azure AI Foundry `/openai/v1`, custom gateways like Bifrost, local
//! servers). Non-streaming `/chat/completions` with tool calls.

use super::{AssistantTurn, ChatMessage, TokenUsage, ToolCall, ToolSpec};
use crate::model::ModelConfig;
use serde::Deserialize;
use serde_json::json;

pub struct OpenAiProvider {
    client: reqwest::Client,
    base_url: String,
    api_key: Option<String>,
    model: String,
    api_version: Option<String>,
}

impl OpenAiProvider {
    pub fn new(cfg: &ModelConfig) -> Self {
        Self {
            client: reqwest::Client::new(),
            base_url: cfg.base_url.clone(),
            api_key: cfg.api_key.clone(),
            model: cfg.model_id.clone(),
            api_version: cfg.api_version.clone(),
        }
    }

    pub async fn chat(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolSpec],
    ) -> anyhow::Result<AssistantTurn> {
        let url = format!("{}/chat/completions", self.base_url.trim_end_matches('/'));
        let tool_json: Vec<_> = tools
            .iter()
            .map(|t| json!({ "type": "function", "function": { "name": t.name, "description": t.description, "parameters": t.parameters } }))
            .collect();
        let mut body = json!({ "model": self.model, "messages": messages });
        if !tool_json.is_empty() {
            body["tools"] = json!(tool_json);
            body["tool_choice"] = json!("auto");
        }

        // Transient failures (network errors, 408/429/5xx) get bounded retries with backoff — one
        // blip must not kill a 30-tool-call turn. Anything else fails immediately.
        let mut last_err = anyhow::anyhow!("no attempts made");
        for (attempt, backoff_ms) in RETRY_BACKOFF_MS.iter().copied().enumerate() {
            if attempt > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)).await;
            }
            let mut req = self.client.post(&url).json(&body);
            if let Some(k) = &self.api_key {
                req = req.bearer_auth(k);
            }
            if let Some(v) = &self.api_version {
                req = req.query(&[("api-version", v.as_str())]);
            }
            let resp = match req.send().await {
                Ok(r) => r,
                Err(e) => {
                    last_err = anyhow::anyhow!("request failed: {e}");
                    continue;
                }
            };
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            if !status.is_success() {
                let snippet: String = text
                    .lines()
                    .next()
                    .unwrap_or("")
                    .chars()
                    .take(300)
                    .collect();
                let err = anyhow::anyhow!("HTTP {}: {}", status.as_u16(), snippet);
                if status.as_u16() == 408 || status.as_u16() == 429 || status.is_server_error() {
                    last_err = err;
                    continue;
                }
                return Err(err);
            }
            return parse_turn(&text);
        }
        Err(last_err.context(format!("giving up after {} attempts", RETRY_BACKOFF_MS.len())))
    }
}

/// Retry schedule: first entry is the immediate attempt, later entries are the waits before each
/// retry. Worst-case added latency ≈ 2s.
const RETRY_BACKOFF_MS: [u64; 3] = [0, 400, 1600];

fn parse_turn(text: &str) -> anyhow::Result<AssistantTurn> {
    let parsed: ChatResponse = serde_json::from_str(text).map_err(|e| {
        anyhow::anyhow!(
            "could not parse response ({e}): {}",
            text.chars().take(200).collect::<String>()
        )
    })?;
    let usage = parsed.usage.map(Into::into);
    let choice = parsed
        .choices
        .into_iter()
        .next()
        .ok_or_else(|| anyhow::anyhow!("no choices in response"))?;
    Ok(AssistantTurn {
        content: choice.message.content,
        tool_calls: choice.message.tool_calls,
        finish_reason: choice.finish_reason.unwrap_or_default(),
        usage,
    })
}

#[derive(Deserialize)]
struct ChatResponse {
    choices: Vec<Choice>,
    #[serde(default)]
    usage: Option<WireUsage>,
}

#[derive(Deserialize)]
struct Choice {
    message: RespMessage,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct RespMessage {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Vec<ToolCall>,
}

#[derive(Deserialize, Default)]
struct WireUsage {
    #[serde(default)]
    prompt_tokens: u64,
    #[serde(default)]
    completion_tokens: u64,
    #[serde(default)]
    total_tokens: u64,
    #[serde(default)]
    prompt_tokens_details: Option<WirePromptDetails>,
}

#[derive(Deserialize, Default)]
struct WirePromptDetails {
    #[serde(default)]
    cached_tokens: u64,
}

impl From<WireUsage> for TokenUsage {
    fn from(u: WireUsage) -> Self {
        TokenUsage {
            prompt_tokens: u.prompt_tokens,
            completion_tokens: u.completion_tokens,
            total_tokens: u.total_tokens,
            cached_tokens: u.prompt_tokens_details.map(|d| d.cached_tokens),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(body: &str) -> AssistantTurn {
        parse_turn(body).unwrap()
    }

    /// A one-shot HTTP server that serves the scripted (status, body) responses in order, counting
    /// hits — just enough surface to exercise the retry loop against real sockets.
    async fn scripted_server(
        responses: Vec<(u16, &'static str)>,
    ) -> (String, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let hits2 = hits.clone();
        tokio::spawn(async move {
            for (status, body) in responses {
                let (mut sock, _) = match listener.accept().await {
                    Ok(s) => s,
                    Err(_) => return,
                };
                hits2.fetch_add(1, Ordering::SeqCst);
                let mut buf = [0u8; 65536];
                let _ = sock.read(&mut buf).await; // one read is enough for these small requests
                let reason = if status == 200 { "OK" } else { "ERR" };
                let resp = format!(
                    "HTTP/1.1 {status} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = sock.write_all(resp.as_bytes()).await;
            }
        });
        (format!("http://{addr}"), hits)
    }

    fn provider(base_url: &str) -> OpenAiProvider {
        OpenAiProvider {
            client: reqwest::Client::new(),
            base_url: base_url.to_string(),
            api_key: None,
            model: "test".into(),
            api_version: None,
        }
    }

    const OK_BODY: &str = r#"{"choices":[{"message":{"content":"hi"},"finish_reason":"stop"}]}"#;

    #[tokio::test]
    async fn retries_transient_errors_then_succeeds() {
        let (url, hits) = scripted_server(vec![(503, "{}"), (429, "{}"), (200, OK_BODY)]).await;
        let turn = provider(&url).chat(&[], &[]).await.expect("retries should recover");
        assert_eq!(turn.content.as_deref(), Some("hi"));
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn does_not_retry_client_errors() {
        let (url, hits) = scripted_server(vec![(400, r#"{"error":"bad request"}"#), (200, OK_BODY)]).await;
        let err = provider(&url).chat(&[], &[]).await.expect_err("400 must fail fast");
        assert!(err.to_string().contains("HTTP 400"));
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 1, "no retry on 4xx");
    }

    #[tokio::test]
    async fn gives_up_after_the_backoff_schedule() {
        let (url, hits) = scripted_server(vec![(503, "{}"), (503, "{}"), (503, "{}"), (200, OK_BODY)]).await;
        let err = provider(&url).chat(&[], &[]).await.expect_err("persistent 503 fails");
        assert!(err.to_string().contains("giving up after 3 attempts"), "{err}");
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 3);
    }

    #[test]
    fn usage_deserializes_with_cached_details() {
        let turn = parse(
            r#"{"choices":[{"message":{"content":"hi"},"finish_reason":"stop"}],
                "usage":{"prompt_tokens":120,"completion_tokens":30,"total_tokens":150,
                         "prompt_tokens_details":{"cached_tokens":64}}}"#,
        );
        let u = turn.usage.expect("usage present");
        assert_eq!(u.prompt_tokens, 120);
        assert_eq!(u.completion_tokens, 30);
        assert_eq!(u.total_tokens, 150);
        assert_eq!(u.cached_tokens, Some(64));
    }

    #[test]
    fn usage_without_details_or_absent() {
        let turn = parse(
            r#"{"choices":[{"message":{"content":"hi"}}],
                "usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}"#,
        );
        let u = turn.usage.unwrap();
        assert_eq!(u.cached_tokens, None);
        assert_eq!(u.total_tokens, 15);

        let none = parse(r#"{"choices":[{"message":{"content":"hi"}}]}"#);
        assert!(none.usage.is_none());
    }
}
