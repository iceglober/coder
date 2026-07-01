//! Model/provider resolution. Port of `model.ts`. Stage 1 wires the OpenAI-compatible path (azure +
//! custom) end-to-end; vertex + anthropic are recognized and preflighted but their clients are staged.

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

/// Resolve the active provider from a string (flag or `AGENTJ_PROVIDER`); default Vertex.
pub fn resolve_provider(value: Option<&str>) -> Provider {
    match value.or(_env("AGENTJ_PROVIDER").as_deref()) {
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

fn custom_base_url(explicit: Option<&str>) -> String {
    explicit
        .map(|s| s.to_string())
        .or_else(|| _env("AGENTJ_BASE_URL"))
        .unwrap_or_default()
}

/// Check provider credentials/config before a run. `Ok(())` when ready; `Err(msg)` with an actionable
/// message otherwise. Mirrors `preflight` in model.ts.
pub fn preflight(sel: &Selector) -> Result<(), String> {
    let model_id = sel
        .model
        .map(|s| s.to_string())
        .or_else(|| _env("AGENTJ_MODEL"));
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
            if custom_base_url(sel.base_url).is_empty() {
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

/// Resolve a runnable model config. Callers preflight first.
pub fn resolve_model(sel: &Selector) -> Result<ModelConfig, String> {
    let model_id = sel
        .model
        .map(|s| s.to_string())
        .or_else(|| _env("AGENTJ_MODEL"))
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
        Provider::Custom => (custom_base_url(sel.base_url), _env("AGENTJ_API_KEY"), None),
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
        assert_eq!(resolve_provider(Some("anthropic")), Provider::Anthropic);
        assert_eq!(resolve_provider(Some("azure")), Provider::Azure);
        assert_eq!(resolve_provider(Some("custom")), Provider::Custom);
        assert_eq!(resolve_provider(Some("openai")), Provider::Vertex);
        assert_eq!(resolve_provider(None), Provider::Vertex);
    }

    #[test]
    fn preflight_messages() {
        // custom without a base url / model
        let s = Selector {
            provider: Provider::Custom,
            model: None,
            base_url: None,
        };
        assert!(preflight(&s).unwrap_err().contains("base URL"));
        let s = Selector {
            provider: Provider::Custom,
            model: Some("m"),
            base_url: Some("http://x/v1"),
        };
        assert!(preflight(&s).is_ok());
    }
}
