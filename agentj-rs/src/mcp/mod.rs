//! MCP support (ratatui edition): `.mcp.json` config + an `rmcp`-backed client whose tools merge into
//! the agent's toolset. Connect once at startup; a server that fails/needs-auth just isn't there.

pub mod client;
pub mod config;
