//! MCP server config — reuses Claude Code's `.mcp.json` format (port of the TS `mcp/config.ts`). Repo
//! `.mcp.json` merged over global `~/.agentj/.mcp.json` (repo wins). String values support
//! `${VAR}` / `${VAR:-default}` expansion. Pure + unit-tested; no `rmcp` dependency.

use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;

#[derive(Debug, Clone, PartialEq)]
pub enum Transport {
    Stdio,
    Http,
    Sse,
}

#[derive(Debug, Clone)]
pub struct McpServerConfig {
    pub name: String,
    pub transport: Transport,
    // stdio
    pub command: Option<String>,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    // remote (http/sse)
    pub url: Option<String>,
    #[allow(dead_code)] // consumed once static-header + OAuth http lands (staged).
    pub headers: HashMap<String, String>,
    pub timeout_ms: Option<u64>,
}

/// Expand `${VAR}` and `${VAR:-default}` using `get` (unset with no default → empty).
pub fn expand_vars(value: &str, get: &impl Fn(&str) -> Option<String>) -> String {
    let mut out = String::new();
    let mut rest = value;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        match after.find('}') {
            Some(end) => {
                let inner = &after[..end];
                let (name, default) = match inner.split_once(":-") {
                    Some((n, d)) => (n, Some(d)),
                    None => (inner, None),
                };
                let val = get(name)
                    .or_else(|| default.map(|s| s.to_string()))
                    .unwrap_or_default();
                out.push_str(&val);
                rest = &after[end + 1..];
            }
            None => {
                out.push_str("${");
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

fn expand_map(
    obj: Option<&Value>,
    get: &impl Fn(&str) -> Option<String>,
) -> HashMap<String, String> {
    let mut out = HashMap::new();
    if let Some(Value::Object(m)) = obj {
        for (k, v) in m {
            if let Some(s) = v.as_str() {
                out.insert(k.clone(), expand_vars(s, get));
            }
        }
    }
    out
}

fn parse_server(
    name: &str,
    raw: &Value,
    get: &impl Fn(&str) -> Option<String>,
) -> Option<McpServerConfig> {
    if !raw.is_object() {
        return None;
    }
    let timeout_ms = raw.get("timeout").and_then(|v| v.as_u64());
    // stdio: identified by `command`.
    if let Some(cmd) = raw.get("command").and_then(|v| v.as_str()) {
        let args = raw
            .get("args")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str())
                    .map(|s| expand_vars(s, get))
                    .collect()
            })
            .unwrap_or_default();
        return Some(McpServerConfig {
            name: name.to_string(),
            transport: Transport::Stdio,
            command: Some(expand_vars(cmd, get)),
            args,
            env: expand_map(raw.get("env"), get),
            url: None,
            headers: HashMap::new(),
            timeout_ms,
        });
    }
    // remote: needs a url. `sse` type → sse; otherwise http (covers `streamable-http`).
    if let Some(url) = raw.get("url").and_then(|v| v.as_str()) {
        let transport = if raw.get("type").and_then(|v| v.as_str()) == Some("sse") {
            Transport::Sse
        } else {
            Transport::Http
        };
        return Some(McpServerConfig {
            name: name.to_string(),
            transport,
            command: None,
            args: vec![],
            env: HashMap::new(),
            url: Some(expand_vars(url, get)),
            headers: expand_map(raw.get("headers"), get),
            timeout_ms,
        });
    }
    None
}

/// Merge two parsed `.mcp.json` documents (repo over global) into resolved configs.
pub fn resolve_mcp_servers(
    global: &Value,
    repo: &Value,
    get: &impl Fn(&str) -> Option<String>,
) -> Vec<McpServerConfig> {
    let mut merged: HashMap<String, Value> = HashMap::new();
    for doc in [global, repo] {
        if let Some(Value::Object(servers)) = doc.get("mcpServers") {
            for (name, raw) in servers {
                merged.insert(name.clone(), raw.clone());
            }
        }
    }
    let mut names: Vec<&String> = merged.keys().collect();
    names.sort();
    names
        .into_iter()
        .filter_map(|n| parse_server(n, &merged[n], get))
        .collect()
}

/// True when a remote server carries a usable static Authorization header (so OAuth is skipped).
#[allow(dead_code)] // used once static-header http lands (staged); kept + tested now.
pub fn has_static_auth(cfg: &McpServerConfig) -> bool {
    cfg.headers
        .iter()
        .any(|(k, v)| k.eq_ignore_ascii_case("authorization") && !v.trim().is_empty())
}

fn read_json(path: &Path) -> Value {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null)
}

/// Load + merge MCP servers for `root`: repo `.mcp.json` over global `~/.agentj/.mcp.json`.
pub fn load_mcp_servers(root: &str) -> Vec<McpServerConfig> {
    let home = std::env::var("HOME").unwrap_or_default();
    let global = read_json(&Path::new(&home).join(".agentj").join(".mcp.json"));
    let repo = read_json(&Path::new(root).join(".mcp.json"));
    resolve_mcp_servers(&global, &repo, &|k| std::env::var(k).ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn get(map: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let owned: HashMap<String, String> = map
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |k: &str| owned.get(k).cloned()
    }

    #[test]
    fn expand() {
        let g = get(&[("TOK", "abc")]);
        assert_eq!(expand_vars("Bearer ${TOK}", &g), "Bearer abc");
        assert_eq!(expand_vars("${MISSING:-fallback}", &g), "fallback");
        assert_eq!(expand_vars("x${MISSING}y", &g), "xy");
    }

    #[test]
    fn repo_wins_and_detects_transport() {
        let global = json!({ "mcpServers": { "a": { "url": "https://global" } } });
        let repo = json!({ "mcpServers": {
            "a": { "url": "https://repo" },
            "local": { "command": "node", "args": ["s.js", "${ARG}"], "env": { "K": "${V}" } },
            "sse": { "type": "sse", "url": "https://x", "headers": { "Authorization": "Bearer ${TOK}" } }
        }});
        let g = get(&[("ARG", "one"), ("V", "two"), ("TOK", "sek")]);
        let out = resolve_mcp_servers(&global, &repo, &g);
        let a = out.iter().find(|s| s.name == "a").unwrap();
        assert_eq!(a.transport, Transport::Http);
        assert_eq!(a.url.as_deref(), Some("https://repo")); // repo wins
        let local = out.iter().find(|s| s.name == "local").unwrap();
        assert_eq!(local.transport, Transport::Stdio);
        assert_eq!(local.args, vec!["s.js", "one"]);
        assert_eq!(local.env.get("K").map(|s| s.as_str()), Some("two"));
        let sse = out.iter().find(|s| s.name == "sse").unwrap();
        assert_eq!(sse.transport, Transport::Sse);
        assert!(has_static_auth(sse));
    }

    #[test]
    fn no_static_auth_when_empty_or_stdio() {
        let repo = json!({ "mcpServers": {
            "s": { "url": "https://x", "headers": { "Authorization": "${UNSET}" } },
            "l": { "command": "node" }
        }});
        let out = resolve_mcp_servers(&json!({}), &repo, &get(&[]));
        assert!(!has_static_auth(
            out.iter().find(|s| s.name == "s").unwrap()
        ));
        assert!(!has_static_auth(
            out.iter().find(|s| s.name == "l").unwrap()
        ));
    }
}
