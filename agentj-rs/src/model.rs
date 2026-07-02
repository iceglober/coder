//! Model/provider resolution. Port of `model.ts`. Stage 1 wires the OpenAI-compatible path (azure +
//! custom) end-to-end; vertex + anthropic are recognized and preflighted but their clients are staged.

use crate::config::AppConfig;
use std::env;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    Vertex,
    Anthropic,
    Azure,
    Custom,
}

impl Provider {
    pub fn as_str(self) -> &'static str {
        match self {
            Provider::Vertex => "vertex",
            Provider::Anthropic => "anthropic",
            Provider::Azure => "azure",
            Provider::Custom => "custom",
        }
    }
}

/// Resolve the active provider from a string (flag or `AGENTJ_PROVIDER`), then app config; default Vertex.
pub fn resolve_provider(value: Option<&str>, app: &AppConfig) -> Provider {
    match value
        .or(_env("AGENTJ_PROVIDER").as_deref())
        .or(app.provider.as_deref())
    {
        Some("anthropic") => Provider::Anthropic,
        Some("azure") => Provider::Azure,
        Some("custom") => Provider::Custom,
        _ => Provider::Vertex,
    }
}

fn _env(k: &str) -> Option<String> {
    env::var(k).ok().filter(|s| !s.is_empty())
}

fn default_model(p: Provider) -> Option<&'static str> {
    match p {
        Provider::Vertex => Some("gemini-2.5-pro"),
        Provider::Anthropic => Some("claude-opus-4-8"),
        Provider::Azure | Provider::Custom => None,
    }
}

/// Everything needed to talk to a model, resolved from flags + env.
#[derive(Debug, Clone)]
pub struct ModelConfig {
    pub provider: Provider,
    pub model_id: String,
    /// Base URL for azure/custom (OpenAI-compatible). Empty for vertex/anthropic.
    pub base_url: String,
    pub api_key: Option<String>,
    /// Azure api-version query param, if set.
    pub api_version: Option<String>,
}

pub struct Selector<'a> {
    pub provider: Provider,
    pub model: Option<&'a str>,
    pub base_url: Option<&'a str>,
}

fn custom_base_url(explicit: Option<&str>, app: &AppConfig) -> String {
    explicit
        .map(|s| s.to_string())
        .or_else(|| _env("AGENTJ_BASE_URL"))
        .or_else(|| app.base_url.clone().filter(|s| !s.is_empty()))
        .unwrap_or_default()
}

/// Check provider credentials/config before a run. `Ok(())` when ready; `Err(msg)` with an actionable
/// message otherwise. Mirrors `preflight` in model.ts.
pub fn preflight(sel: &Selector, app: &AppConfig) -> Result<(), String> {
    let model_id = sel
        .model
        .map(|s| s.to_string())
        .or_else(|| _env("AGENTJ_MODEL"))
        .or_else(|| app.model.clone().filter(|s| !s.is_empty()));
    match sel.provider {
        Provider::Vertex => {
            if _env("GOOGLE_VERTEX_PROJECT").is_none() {
                return Err("Vertex provider needs GOOGLE_VERTEX_PROJECT set (auth via `gcloud auth application-default login`). [vertex client staged — stage 2]".into());
            }
            Ok(())
        }
        Provider::Anthropic => {
            if _env("ANTHROPIC_API_KEY").is_none() {
                return Err("Anthropic provider needs ANTHROPIC_API_KEY set. [anthropic client staged — stage 2]".into());
            }
            Ok(())
        }
        Provider::Azure => {
            if _env("AZURE_BASE_URL").is_none() {
                return Err("Azure provider needs AZURE_BASE_URL set (your Foundry OpenAI-compatible endpoint, e.g. https://<resource>.openai.azure.com/openai/v1).".into());
            }
            if _env("AZURE_API_KEY").is_none() {
                return Err("Azure provider needs AZURE_API_KEY set.".into());
            }
            if model_id.is_none() {
                return Err("Azure provider has no default model — set AGENTJ_MODEL or pass --model (the Foundry deployment name).".into());
            }
            Ok(())
        }
        Provider::Custom => {
            if custom_base_url(sel.base_url, app).is_empty() {
                return Err("Custom provider needs a base URL — set AGENTJ_BASE_URL or pass --base-url (e.g. a Bifrost gateway: http://localhost:8080/v1).".into());
            }
            if model_id.is_none() {
                return Err(
                    "Custom provider has no default model — set AGENTJ_MODEL or pass --model."
                        .into(),
                );
            }
            Ok(())
        }
    }
}

/// Context-window size (total token budget) for a known model id, matched case-insensitively by
/// prefix. `None` when unknown, so callers omit the context meter rather than guess. Values are
/// approximate published limits; `AGENTJ_CONTEXT_WINDOW` overrides for a specific deployment.
pub fn context_window(model_id: &str) -> Option<u64> {
    const TABLE: &[(&str, u64)] = &[
        ("gpt-5", 400_000),
        ("gpt-4.1", 1_047_576),
        ("gpt-4o", 128_000),
        ("o4-mini", 200_000),
        ("o3", 200_000),
        ("o1", 200_000),
        ("claude", 200_000),
        ("gemini-2.5", 1_048_576),
        ("gemini-1.5", 1_048_576),
        ("gemini-2.0", 1_048_576),
    ];
    let id = model_id.to_ascii_lowercase();
    TABLE
        .iter()
        .find(|(prefix, _)| id.starts_with(prefix))
        .map(|(_, window)| *window)
}

/// Resolve a runnable model config. Callers preflight first.
pub fn resolve_model(sel: &Selector, app: &AppConfig) -> Result<ModelConfig, String> {
    let model_id = sel
        .model
        .map(|s| s.to_string())
        .or_else(|| _env("AGENTJ_MODEL"))
        .or_else(|| app.model.clone().filter(|s| !s.is_empty()))
        .or_else(|| default_model(sel.provider).map(|s| s.to_string()))
        .ok_or_else(|| {
            format!(
                "No model id for provider \"{}\" — set AGENTJ_MODEL or pass --model.",
                sel.provider.as_str()
            )
        })?;

    let (base_url, api_key, api_version) = match sel.provider {
        Provider::Azure => (
            _env("AZURE_BASE_URL").unwrap_or_default(),
            _env("AZURE_API_KEY"),
            _env("AZURE_API_VERSION"),
        ),
        Provider::Custom => (custom_base_url(sel.base_url, app), _env("AGENTJ_API_KEY"), None),
        Provider::Vertex => (String::new(), None, None),
        Provider::Anthropic => (String::new(), _env("ANTHROPIC_API_KEY"), None),
    };
    Ok(ModelConfig {
        provider: sel.provider,
        model_id,
        base_url,
        api_key,
        api_version,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_resolution() {
        let empty = AppConfig::default();
        assert_eq!(resolve_provider(Some("anthropic"), &empty), Provider::Anthropic);
        assert_eq!(resolve_provider(Some("azure"), &empty), Provider::Azure);
        assert_eq!(resolve_provider(Some("custom"), &empty), Provider::Custom);
        assert_eq!(resolve_provider(Some("openai"), &empty), Provider::Vertex);
        assert_eq!(resolve_provider(None, &empty), Provider::Vertex);
        assert_eq!(
            resolve_provider(
                None,
                &AppConfig {
                    provider: Some("azure".into()),
                    ..Default::default()
                }
            ),
            Provider::Azure
        );
    }

    #[test]
    fn context_window_prefix_lookup() {
        assert_eq!(context_window("gpt-4o-mini"), Some(128_000));
        assert_eq!(context_window("GPT-5.2"), Some(400_000)); // case-insensitive
        assert_eq!(context_window("claude-opus-4-8"), Some(200_000));
        assert_eq!(context_window("gemini-2.5-pro"), Some(1_048_576));
        assert_eq!(context_window("some-unknown-model"), None);
    }

    #[test]
    fn preflight_messages() {
        // custom without a base url / model
        let s = Selector {
            provider: Provider::Custom,
            model: None,
            base_url: None,
        };
        assert!(preflight(&s, &AppConfig::default()).unwrap_err().contains("base URL"));
        let s = Selector {
            provider: Provider::Custom,
            model: Some("m"),
            base_url: Some("http://x/v1"),
        };
        assert!(preflight(&s, &AppConfig::default()).is_ok());
    }
}
