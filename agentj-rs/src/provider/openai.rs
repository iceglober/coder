//! OpenAI-compatible chat client (Azure AI Foundry `/openai/v1`, custom gateways like Bifrost, local
//! servers). Non-streaming `/chat/completions` with tool calls.

use super::{AssistantTurn, ChatMessage, ToolCall, ToolSpec};
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

        let mut req = self.client.post(&url).json(&body);
        if let Some(k) = &self.api_key {
            req = req.bearer_auth(k);
        }
        if let Some(v) = &self.api_version {
            req = req.query(&[("api-version", v.as_str())]);
        }

        let resp = req.send().await?;
        let status = resp.status();
        let text = resp.text().await?;
        if !status.is_success() {
            let snippet: String = text
                .lines()
                .next()
                .unwrap_or("")
                .chars()
                .take(300)
                .collect();
            anyhow::bail!("HTTP {}: {}", status.as_u16(), snippet);
        }
        let parsed: ChatResponse = serde_json::from_str(&text).map_err(|e| {
            anyhow::anyhow!(
                "could not parse response ({e}): {}",
                text.chars().take(200).collect::<String>()
            )
        })?;
        let choice = parsed
            .choices
            .into_iter()
            .next()
            .ok_or_else(|| anyhow::anyhow!("no choices in response"))?;
        Ok(AssistantTurn {
            content: choice.message.content,
            tool_calls: choice.message.tool_calls,
            finish_reason: choice.finish_reason.unwrap_or_default(),
        })
    }
}

#[derive(Deserialize)]
struct ChatResponse {
    choices: Vec<Choice>,
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
