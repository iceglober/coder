//! Runtime knobs, resolved once from the environment at startup instead of re-read on every loop
//! iteration.

use std::time::Duration;

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
}

impl Config {
    pub fn from_env() -> Self {
        Self::parse(|k| std::env::var(k).ok())
    }

    /// Pure resolver (a `get` closure stands in for the environment) so it's testable without
    /// mutating process-global env in parallel tests.
    fn parse(get: impl Fn(&str) -> Option<String>) -> Self {
        let num = |k: &str| get(k).and_then(|s| s.parse::<u64>().ok());
        Config {
            max_steps: num("AGENTJ_MAX_STEPS").filter(|n| *n >= 1).unwrap_or(40) as usize,
            max_idle_nudges: num("AGENTJ_MAX_IDLE_NUDGES").unwrap_or(6) as usize,
            idle_wait: Duration::from_secs(num("AGENTJ_JOB_IDLE_WAIT_S").unwrap_or(120)),
            max_parallel_subagents: num("AGENTJ_MAX_PARALLEL_SUBAGENTS")
                .filter(|n| *n >= 1)
                .unwrap_or(4) as usize,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn from(pairs: &[(&str, &str)]) -> Config {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        Config::parse(|k| map.get(k).cloned())
    }

    #[test]
    fn parse_defaults_and_invalid_values() {
        let d = from(&[]);
        assert_eq!(d.max_steps, 40);
        assert_eq!(d.max_idle_nudges, 6);
        assert_eq!(d.idle_wait, Duration::from_secs(120));
        assert_eq!(d.max_parallel_subagents, 4);

        // zero/garbage fall back to the default where a minimum applies
        assert_eq!(from(&[("AGENTJ_MAX_STEPS", "0")]).max_steps, 40);
        assert_eq!(from(&[("AGENTJ_MAX_STEPS", "nope")]).max_steps, 40);
        assert_eq!(from(&[("AGENTJ_MAX_PARALLEL_SUBAGENTS", "0")]).max_parallel_subagents, 4);

        // valid overrides win
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
}
