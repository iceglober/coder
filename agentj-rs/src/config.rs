//! Runtime knobs and app config, resolved once at startup instead of re-read on every loop
//! iteration.

use serde::Deserialize;
use std::path::Path;
use std::time::Duration;

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AppConfig {
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default, rename = "base_url")]
    pub base_url: Option<String>,
    #[serde(default)]
    pub company: Option<String>,
    #[serde(default)]
    pub max_steps: Option<u64>,
    #[serde(default)]
    pub max_idle_nudges: Option<u64>,
    #[serde(default)]
    pub job_idle_wait_s: Option<u64>,
    /// The project's check command (tests/build/lint), e.g. "cargo test". Drives the ASSESS gate
    /// and is surfaced in the system prompt.
    #[serde(default)]
    pub check: Option<String>,
}

impl AppConfig {
    fn merge(&mut self, other: Self) {
        self.provider = other.provider.or(self.provider.take());
        self.model = other.model.or(self.model.take());
        self.base_url = other.base_url.or(self.base_url.take());
        self.company = other.company.or(self.company.take());
        self.max_steps = other.max_steps.or(self.max_steps.take());
        self.max_idle_nudges = other.max_idle_nudges.or(self.max_idle_nudges.take());
        self.job_idle_wait_s = other.job_idle_wait_s.or(self.job_idle_wait_s.take());
        self.check = other.check.or(self.check.take());
    }

    pub fn load(root: &str) -> Self {
        let home = std::env::var("HOME").unwrap_or_default();
        let mut cfg = AppConfig::default();
        for path in [
            Path::new(&home).join(".config").join("aj").join("aj.json"),
            Path::new(root).join(".aj").join("aj.json"),
            Path::new(root).join(".aj").join("aj.local.json"),
        ] {
            cfg.merge(read_config(&path));
        }
        cfg
    }

    pub fn env_or_file(key: &str, file: Option<&str>) -> Option<String> {
        std::env::var(key)
            .ok()
            .filter(|s| !s.is_empty())
            .or_else(|| file.filter(|s| !s.is_empty()).map(|s| s.to_string()))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Config {
    /// Max model steps in one turn (`AGENTJ_MAX_STEPS`).
    pub max_steps: usize,
    /// How many times a turn may idle-wait for a background-job nudge (`AGENTJ_MAX_IDLE_NUDGES`).
    pub max_idle_nudges: usize,
    /// Ceiling on a single idle-wait (`AGENTJ_JOB_IDLE_WAIT_S`).
    pub idle_wait: Duration,
    /// Bound on subagents running at once (`AGENTJ_MAX_PARALLEL_SUBAGENTS`).
    pub max_parallel_subagents: usize,
    /// Model context window for the context meter: `AGENTJ_CONTEXT_WINDOW` > model table > `None`.
    pub context_window: Option<u64>,
    /// Compact older tool-result bodies once a model call's prompt exceeds this many tokens. ABSOLUTE
    /// (not a fraction of the window): a 400k-window model whose task context peaks at 40k would never
    /// trip a window-relative threshold, so compaction was dead weight exactly where it was needed.
    /// `AGENTJ_COMPACT_THRESHOLD` > default 12000, clamped to ≤ 70% of the window when known. This is a
    /// context-management safety valve, NOT a token-tail fix: a live A/B on the runaway fixture showed
    /// it only reclaims tokens when the OLD tool results are large (>200 chars) — measured cutting a
    /// 14.4k-token call to 8.5k when big file reads had aged out. Runs whose bloat is accumulation of
    /// many SMALL messages (edits, brief test output, tool-call args) get no benefit; that tail needs a
    /// different lever (fewer round-trips / summarize-restart), not tool-body elision.
    pub compact_threshold: u64,
    /// The project's check command (`AGENTJ_CHECK` > aj.json `check` > None → heuristics).
    pub check: Option<String>,
}

impl Config {
    pub fn from_sources(model_id: &str, app: &AppConfig) -> Self {
        Self::parse(
            |k| std::env::var(k).ok(),
            model_id,
            RuntimeFileConfig {
                max_steps: app.max_steps,
                max_idle_nudges: app.max_idle_nudges,
                job_idle_wait_s: app.job_idle_wait_s,
                check: app.check.clone(),
            },
        )
    }

    /// Pure resolver (a `get` closure stands in for the environment) so it's testable without
    /// mutating process-global env in parallel tests.
    fn parse(
        get: impl Fn(&str) -> Option<String>,
        model_id: &str,
        file: RuntimeFileConfig,
    ) -> Self {
        let env_num = |k: &str| get(k).and_then(|s| s.parse::<u64>().ok());
        let num = |k: &str, file_value: Option<u64>| env_num(k).or(file_value);
        let context_window = env_num("AGENTJ_CONTEXT_WINDOW").or_else(|| crate::model::context_window(model_id));
        Config {
            max_steps: num("AGENTJ_MAX_STEPS", file.max_steps)
                .filter(|n| *n >= 1)
                .unwrap_or(40) as usize,
            max_idle_nudges: num("AGENTJ_MAX_IDLE_NUDGES", file.max_idle_nudges).unwrap_or(6) as usize,
            idle_wait: Duration::from_secs(num("AGENTJ_JOB_IDLE_WAIT_S", file.job_idle_wait_s).unwrap_or(120)),
            max_parallel_subagents: env_num("AGENTJ_MAX_PARALLEL_SUBAGENTS")
                .filter(|n| *n >= 1)
                .unwrap_or(4) as usize,
            context_window,
            // Absolute (not window-relative) so it fires on big-window models; clamp below 70% of the
            // window when one is known so a small-window model never compacts too late.
            compact_threshold: env_num("AGENTJ_COMPACT_THRESHOLD")
                .filter(|n| *n >= 1000)
                .unwrap_or(12_000)
                .min(context_window.map_or(u64::MAX, |w| w * 7 / 10)),
            check: get("AGENTJ_CHECK").filter(|s| !s.is_empty()).or(file.check),
        }
    }
}

#[derive(Clone)]
struct RuntimeFileConfig {
    max_steps: Option<u64>,
    max_idle_nudges: Option<u64>,
    job_idle_wait_s: Option<u64>,
    check: Option<String>,
}

fn read_config(path: &Path) -> AppConfig {
    match std::fs::read_to_string(path) {
        Ok(s) => match serde_json::from_str(&s) {
            Ok(cfg) => cfg,
            Err(err) => {
                eprintln!("warning: ignoring invalid config file {}: {err}", path.display());
                AppConfig::default()
            }
        },
        Err(_) => AppConfig::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn from(pairs: &[(&str, &str)]) -> Config {
        from_all(
            pairs,
            "unknown-model",
            RuntimeFileConfig {
                max_steps: None,
                max_idle_nudges: None,
                job_idle_wait_s: None,
                check: None,
            },
        )
    }

    fn e_file() -> RuntimeFileConfig {
        RuntimeFileConfig {
            max_steps: None,
            max_idle_nudges: None,
            job_idle_wait_s: None,
            check: Some("make check".into()),
        }
    }

    fn from_all(pairs: &[(&str, &str)], model_id: &str, file: RuntimeFileConfig) -> Config {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        Config::parse(|k| map.get(k).cloned(), model_id, file)
    }

    #[test]
    fn parse_defaults_and_invalid_values() {
        let d = from(&[]);
        assert_eq!(d.max_steps, 40);
        assert_eq!(d.max_idle_nudges, 6);
        assert_eq!(d.idle_wait, Duration::from_secs(120));
        assert_eq!(d.max_parallel_subagents, 4);
        assert_eq!(d.context_window, None);

        assert_eq!(from(&[("AGENTJ_MAX_STEPS", "0")]).max_steps, 40);
        assert_eq!(from(&[("AGENTJ_MAX_STEPS", "nope")]).max_steps, 40);
        assert_eq!(from(&[("AGENTJ_MAX_PARALLEL_SUBAGENTS", "0")]).max_parallel_subagents, 4);

        let o = from(&[
            ("AGENTJ_MAX_STEPS", "10"),
            ("AGENTJ_MAX_IDLE_NUDGES", "2"),
            ("AGENTJ_JOB_IDLE_WAIT_S", "30"),
            ("AGENTJ_MAX_PARALLEL_SUBAGENTS", "8"),
        ]);
        assert_eq!(o.max_steps, 10);
        assert_eq!(o.max_idle_nudges, 2);
        assert_eq!(o.idle_wait, Duration::from_secs(30));
        assert_eq!(o.max_parallel_subagents, 8);
    }

    #[test]
    fn file_values_fill_in_and_env_overrides_them() {
        let file = RuntimeFileConfig {
            max_steps: Some(9),
            max_idle_nudges: Some(3),
            job_idle_wait_s: Some(15),
            check: Some("make check".into()),
        };
        let d = from_all(&[], "unknown-model", file.clone());
        assert_eq!(d.max_steps, 9);
        assert_eq!(d.max_idle_nudges, 3);
        assert_eq!(d.idle_wait, Duration::from_secs(15));
        assert_eq!(d.max_parallel_subagents, 4);
        assert_eq!(d.context_window, None);

        let e = from_all(&[("AGENTJ_MAX_STEPS", "11")], "unknown-model", file);
        assert_eq!(e.max_steps, 11);
        assert_eq!(e.check.as_deref(), Some("make check"));
        assert_eq!(
            from_all(&[("AGENTJ_CHECK", "bun test")], "unknown-model", e_file()).check.as_deref(),
            Some("bun test")
        );
    }

    #[test]
    fn compact_threshold_is_absolute_and_window_clamped() {
        // Unknown window → the plain absolute default (compaction still works, unlike the old
        // window-relative rule that never fired without a known window).
        assert_eq!(from(&[]).compact_threshold, 12_000);
        // Env override, clamped to a floor of 1000.
        assert_eq!(from(&[("AGENTJ_COMPACT_THRESHOLD", "40000")]).compact_threshold, 40_000);
        assert_eq!(from(&[("AGENTJ_COMPACT_THRESHOLD", "500")]).compact_threshold, 12_000);
        // A big window leaves the absolute default untouched (the whole point: a 400k-window model
        // compacts at 12k, not 280k).
        assert_eq!(from(&[("AGENTJ_CONTEXT_WINDOW", "400000")]).compact_threshold, 12_000);
        // A tiny window clamps the threshold below the default so it stays ≤ 70% of the window.
        assert_eq!(from(&[("AGENTJ_CONTEXT_WINDOW", "8000")]).compact_threshold, 5_600);
    }

    #[test]
    fn context_window_env_overrides_model_table() {
        assert_eq!(
            from_all(
                &[],
                "gpt-4o",
                RuntimeFileConfig {
                    max_steps: None,
                    max_idle_nudges: None,
                    job_idle_wait_s: None,
                    check: None,
                }
            )
            .context_window,
            Some(128_000)
        );
        assert_eq!(
            from_all(
                &[("AGENTJ_CONTEXT_WINDOW", "500000")],
                "gpt-4o",
                RuntimeFileConfig {
                    max_steps: None,
                    max_idle_nudges: None,
                    job_idle_wait_s: None,
                    check: None,
                }
            )
            .context_window,
            Some(500_000)
        );
        assert_eq!(from(&[]).context_window, None);
    }

    #[test]
    fn app_config_merge_is_layered() {
        let mut cfg = AppConfig {
            provider: Some("vertex".into()),
            model: Some("one".into()),
            ..Default::default()
        };
        cfg.merge(AppConfig {
            model: Some("two".into()),
            base_url: Some("http://x".into()),
            ..Default::default()
        });
        cfg.merge(AppConfig {
            company: Some("iceglober".into()),
            ..Default::default()
        });
        assert_eq!(cfg.provider.as_deref(), Some("vertex"));
        assert_eq!(cfg.model.as_deref(), Some("two"));
        assert_eq!(cfg.base_url.as_deref(), Some("http://x"));
        assert_eq!(cfg.company.as_deref(), Some("iceglober"));
    }

    #[test]
    fn read_config_rejects_unknown_keys() {
        let dir = std::env::temp_dir().join(format!(
            "agentj-config-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("aj.json");
        std::fs::write(&path, r#"{"provider":"custom","context_window":1}"#).unwrap();
        assert_eq!(read_config(&path), AppConfig::default());
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn env_or_file_prefers_env_then_file_then_none() {
        // Uniquely-named key so setting it can't race other tests reading process-global env.
        let key = "__AGENTJ_TEST_ENV_WINS__";
        std::env::set_var(key, "from-env");
        assert_eq!(AppConfig::env_or_file(key, Some("file")), Some("from-env".into()), "env wins over file");
        // An empty env value is treated as unset and falls through to the file.
        std::env::set_var(key, "");
        assert_eq!(AppConfig::env_or_file(key, Some("file")), Some("file".into()));
        std::env::remove_var(key);
        assert_eq!(AppConfig::env_or_file("__AGENTJ_TEST_MISSING__", Some("file")), Some("file".into()));
        assert_eq!(AppConfig::env_or_file("__AGENTJ_TEST_MISSING__", Some("")), None);
    }
}
