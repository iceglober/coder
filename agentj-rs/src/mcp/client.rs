//! MCP client (rmcp). Connects to each configured server once at startup, lists its tools, and
//! exposes them as `ToolSpec`s (named `<server>__<tool>`) that merge into the agent's toolset. Tool
//! calls route back here. Stage 1: stdio (child process) + streamable-http with a static
//! `Authorization` header; OAuth is staged.

use crate::mcp::config::{McpServerConfig, Transport};
use crate::provider::ToolSpec;
use rmcp::model::CallToolRequestParams;
use rmcp::service::RunningService;
use rmcp::transport::{StreamableHttpClientTransport, TokioChildProcess};
use rmcp::{RoleClient, ServiceExt};
use serde_json::{json, Value};
use std::collections::HashMap;

struct McpTool {
    full_name: String,
    short_name: String,
    description: String,
    input_schema: Value,
}

struct Server {
    service: RunningService<RoleClient, ()>,
    tools: Vec<McpTool>,
}

/// Connected MCP servers + a lookup from fully-qualified tool name to its server.
pub struct McpClients {
    servers: Vec<Server>,
    by_tool: HashMap<String, usize>,
}

fn render_result(res: rmcp::model::CallToolResult) -> String {
    let text = res
        .content
        .iter()
        .filter_map(|c| c.as_text().map(|t| t.text.clone()))
        .collect::<Vec<_>>()
        .join("\n");
    if res.is_error.unwrap_or(false) {
        format!(
            "error: {}",
            if text.is_empty() {
                "tool reported an error".to_string()
            } else {
                text
            }
        )
    } else if !text.is_empty() {
        text
    } else if let Some(sc) = res.structured_content {
        sc.to_string()
    } else {
        "(no output)".to_string()
    }
}

async fn connect_one(cfg: &McpServerConfig) -> anyhow::Result<Server> {
    let service = match cfg.transport {
        Transport::Stdio => {
            let mut command = tokio::process::Command::new(cfg.command.clone().unwrap_or_default());
            command.args(&cfg.args);
            for (k, v) in &cfg.env {
                command.env(k, v);
            }
            let transport = TokioChildProcess::new(command)?;
            ().serve(transport).await?
        }
        Transport::Http | Transport::Sse => {
            // Stage 1: plain streamable-http. Static `Authorization` headers + OAuth are staged (a
            // server needing either just surfaces as a connect notice for now).
            let url = cfg.url.clone().unwrap_or_default();
            let transport = StreamableHttpClientTransport::from_uri(url);
            ().serve(transport).await?
        }
    };

    let raw = service.list_all_tools().await?;
    let tools = raw
        .into_iter()
        .map(|t| McpTool {
            full_name: format!("{}__{}", cfg.name, t.name),
            short_name: t.name.to_string(),
            description: t.description.map(|d| d.to_string()).unwrap_or_default(),
            input_schema: serde_json::to_value(&*t.input_schema)
                .unwrap_or_else(|_| json!({ "type": "object" })),
        })
        .collect();
    Ok(Server { service, tools })
}

/// Connect to every configured server, each bounded by a timeout so one hung server can't freeze
/// startup. Returns the clients plus one-line notices for failures/timeouts.
pub async fn connect_all(configs: &[McpServerConfig]) -> (McpClients, Vec<String>) {
    use std::time::Duration;
    let mut servers = Vec::new();
    let mut by_tool = HashMap::new();
    let mut notices = Vec::new();
    for cfg in configs {
        let timeout = cfg
            .timeout_ms
            .map(Duration::from_millis)
            .unwrap_or(Duration::from_secs(30));
        match tokio::time::timeout(timeout, connect_one(cfg)).await {
            Ok(Ok(server)) => {
                let idx = servers.len();
                for t in &server.tools {
                    by_tool.insert(t.full_name.clone(), idx);
                }
                servers.push(server);
            }
            Ok(Err(e)) => notices.push(format!("MCP \"{}\" failed to connect: {}", cfg.name, e)),
            Err(_) => notices.push(format!(
                "MCP \"{}\" timed out connecting (>{}s)",
                cfg.name,
                timeout.as_secs()
            )),
        }
    }
    (McpClients { servers, by_tool }, notices)
}

impl McpClients {
    /// Tool specs advertised to the model (each `<server>__<tool>`).
    pub fn specs(&self) -> Vec<ToolSpec> {
        self.servers
            .iter()
            .flat_map(|s| {
                s.tools.iter().map(|t| ToolSpec {
                    name: t.full_name.clone(),
                    description: t.description.clone(),
                    parameters: t.input_schema.clone(),
                })
            })
            .collect()
    }

    pub fn has_tool(&self, name: &str) -> bool {
        self.by_tool.contains_key(name)
    }

    pub fn tool_count(&self) -> usize {
        self.by_tool.len()
    }

    /// Call an MCP tool by its fully-qualified name, returning flattened text.
    pub async fn call(&self, name: &str, args: &Value) -> String {
        let Some(&idx) = self.by_tool.get(name) else {
            return format!("error: unknown MCP tool `{name}`");
        };
        let server = &self.servers[idx];
        let short = server
            .tools
            .iter()
            .find(|t| t.full_name == name)
            .map(|t| t.short_name.clone())
            .unwrap_or_default();
        let mut params = CallToolRequestParams::new(short);
        if let Some(obj) = args.as_object() {
            params = params.with_arguments(obj.clone());
        }
        match server.service.call_tool(params).await {
            Ok(res) => render_result(res),
            Err(e) => format!("error: {e}"),
        }
    }
}
