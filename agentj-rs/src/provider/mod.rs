//! LLM provider layer. Stage 1 wires the OpenAI-compatible client (azure + custom); vertex/anthropic
//! are staged. Non-streaming on purpose, matching the TS agent (Vertex mangles Gemini thought
//! signatures on streamed tool replay).

pub mod openai;

use crate::model::{ModelConfig, Provider};
use openai::OpenAiProvider;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A tool as advertised to the model (OpenAI function-calling shape).
#[derive(Clone)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

fn fn_type() -> String {
    "function".to_string()
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct FunctionCall {
    pub name: String,
    #[serde(default)]
    pub arguments: String,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct ToolCall {
    #[serde(default)]
    pub id: String,
    #[serde(rename = "type", default = "fn_type")]
    pub kind: String,
    pub function: FunctionCall,
}

/// A chat message in the OpenAI wire shape (also our internal history representation).
#[derive(Clone, Serialize, Deserialize, Debug, Default)]
pub struct ChatMessage {
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub tool_calls: Vec<ToolCall>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

impl ChatMessage {
    pub fn system(text: impl Into<String>) -> Self {
        Self {
            role: "system".into(),
            content: Some(text.into()),
            ..Default::default()
        }
    }
    pub fn user(text: impl Into<String>) -> Self {
        Self {
            role: "user".into(),
            content: Some(text.into()),
            ..Default::default()
        }
    }
}

/// What the model returned for one step.
pub struct AssistantTurn {
    pub content: Option<String>,
    pub tool_calls: Vec<ToolCall>,
    #[allow(dead_code)] // consumed by supervised auto-continue (stage 2).
    pub finish_reason: String,
}

/// A scripted model step for tests: hand the loop a canned turn, an error, or a panic.
#[cfg(test)]
pub enum ScriptStep {
    Turn(AssistantTurn),
    Err(String),
    Panic,
}

/// The resolved provider. An enum (not a trait) so we avoid an async-trait dep; new variants land as
/// vertex/anthropic are wired.
pub enum Llm {
    OpenAi(OpenAiProvider),
    /// A test seam: pops scripted steps so the agent loop is exercisable without a network.
    #[cfg(test)]
    Script(std::sync::Mutex<std::collections::VecDeque<ScriptStep>>),
}

impl Llm {
    pub fn from_config(cfg: &ModelConfig) -> anyhow::Result<Llm> {
        match cfg.provider {
            Provider::Azure | Provider::Custom => Ok(Llm::OpenAi(OpenAiProvider::new(cfg))),
            other => anyhow::bail!(
                "provider `{}` isn't wired in the ratatui edition yet (stage 2)",
                other.as_str()
            ),
        }
    }

    pub async fn chat(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolSpec],
    ) -> anyhow::Result<AssistantTurn> {
        match self {
            Llm::OpenAi(p) => p.chat(messages, tools).await,
            #[cfg(test)]
            Llm::Script(steps) => {
                // Pop under the lock, then release it before acting — so a scripted panic doesn't
                // poison the mutex for later steps.
                let step = steps.lock().unwrap().pop_front();
                match step {
                    Some(ScriptStep::Turn(t)) => Ok(t),
                    Some(ScriptStep::Err(e)) => anyhow::bail!("{e}"),
                    Some(ScriptStep::Panic) => panic!("scripted subagent panic"),
                    None => anyhow::bail!("script exhausted"),
                }
            }
        }
    }
}
