//! agentj — CLI entry (ratatui edition). Parses flags, runs `--once` headlessly, the interactive
//! ratatui chat, or `mcp` subcommands.

mod agent;
mod commands;
mod events;
mod exec;
mod jobs;
mod mcp;
mod model;
mod prompt;
mod provider;
mod rekey;
mod subagent;
mod tools;
mod tui;

use events::AgentEvent;
use model::{preflight, resolve_model, resolve_provider, Provider, Selector};
use provider::{ChatMessage, Llm};
use std::path::PathBuf;
use std::sync::Arc;
use tools::Tools;

const HELP: &str = "\
agentj — a simple terminal coding agent (ratatui edition)

Usage:
  agentj                     chat in the current repo (full-screen ratatui)
  agentj --once \"<task>\"      run one task headlessly, then exit
  agentj mcp list            show configured MCP servers + tool count

Options:
  --provider <name>   vertex | anthropic | azure | custom (env AGENTJ_PROVIDER; default vertex)
  --model <id>        model id (env AGENTJ_MODEL; required for azure/custom)
  --base-url <url>    endpoint for --provider custom (env AGENTJ_BASE_URL)
  -h, --help          show this help
  -v, --version       show version

Notes: azure/custom (OpenAI-compatible) providers are wired; vertex/anthropic are staged. MCP works
for stdio + no-auth streamable-http servers (from .mcp.json); static-header/OAuth servers are staged.";

struct Args {
    provider: Option<Provider>,
    model: Option<String>,
    base_url: Option<String>,
    once: Option<String>,
    help: bool,
    version: bool,
}

fn parse_args(argv: &[String]) -> Args {
    let mut a = Args {
        provider: None,
        model: None,
        base_url: None,
        once: None,
        help: false,
        version: false,
    };
    let mut i = 0;
    while i < argv.len() {
        match argv[i].as_str() {
            "-h" | "--help" => a.help = true,
            "-v" | "--version" => a.version = true,
            "--provider" => {
                i += 1;
                a.provider = argv.get(i).map(|s| resolve_provider(Some(s)));
            }
            "--model" => {
                i += 1;
                a.model = argv.get(i).cloned();
            }
            "--base-url" => {
                i += 1;
                a.base_url = argv.get(i).cloned();
            }
            "--once" => {
                i += 1;
                a.once = argv.get(i).cloned();
            }
            _ => {}
        }
        i += 1;
    }
    a
}

/// The git repo root for cwd, or cwd itself when it isn't a git repo.
async fn repo_root() -> String {
    let cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| ".".into());
    if let Ok(o) = exec::run(&["git", "rev-parse", "--show-toplevel"], &cwd, None).await {
        let top = o.stdout.trim();
        if o.exit_code == 0 && !top.is_empty() {
            return top.to_string();
        }
    }
    cwd
}

/// `agentj mcp <list|login|logout>`.
async fn run_mcp(sub: &[String]) {
    let root = repo_root().await;
    let configs = mcp::config::load_mcp_servers(&root);
    match sub.first().map(|s| s.as_str()) {
        Some("list") => {
            if configs.is_empty() {
                println!(
                    "No MCP servers configured (.mcp.json not found in this repo or ~/.agentj/)."
                );
                return;
            }
            println!("Configured MCP servers:");
            for c in &configs {
                println!("  {:20} {:?}", c.name, c.transport);
            }
            let (clients, notices) = mcp::client::connect_all(&configs).await;
            println!("Connected: {} tool(s) available.", clients.tool_count());
            for n in notices {
                println!("  ! {n}");
            }
        }
        Some("login") | Some("logout") => {
            println!("MCP OAuth login/logout is staged. Today: stdio servers and no-auth streamable-http work; static-`Authorization`-header and OAuth servers are the next step.");
        }
        _ => println!("usage: agentj mcp <list | login | logout>"),
    }
}

#[tokio::main]
async fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let args = parse_args(&argv);

    if args.help {
        println!("{HELP}");
        return;
    }
    if args.version {
        println!("agentj {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    if argv.first().map(|s| s.as_str()) == Some("mcp") {
        run_mcp(&argv[1..]).await;
        return;
    }

    let provider = args.provider.unwrap_or_else(|| resolve_provider(None));
    let sel = Selector {
        provider,
        model: args.model.as_deref(),
        base_url: args.base_url.as_deref(),
    };
    if let Err(e) = preflight(&sel) {
        eprintln!("{e}");
        std::process::exit(1);
    }
    let cfg = match resolve_model(&sel) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };
    let llm = match Llm::from_config(&cfg) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };

    let root = repo_root().await;
    let company = std::env::var("AGENTJ_COMPANY")
        .ok()
        .filter(|s| !s.is_empty());
    let system = prompt::system_prompt(&root, company.as_deref());

    // Connect MCP servers once at startup; failures become one-line notices.
    let mcp_configs = mcp::config::load_mcp_servers(&root);
    let (mcp_clients, mcp_notices) = if mcp_configs.is_empty() {
        (None, Vec::new())
    } else {
        let (c, n) = mcp::client::connect_all(&mcp_configs).await;
        (Some(Arc::new(c)), n)
    };

    let jobs = jobs::JobManager::new(root.clone());
    let tools = Tools::new(PathBuf::from(&root), jobs.clone(), mcp_clients);

    if let Some(task) = args.once {
        // Headless one-shot: run a turn, print events to stdout, exit on the result.
        for n in &mcp_notices {
            eprintln!("! {n}");
        }
        let mut messages = vec![ChatMessage::system(system), ChatMessage::user(task)];
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<AgentEvent>();
        let llm = Arc::new(llm);
        let tools = Arc::new(tools);
        let turn = tokio::spawn(async move {
            let _ = agent::run_turn(&llm, &tools, &mut messages, &tx, true).await;
        });
        let mut failed = false;
        while let Some(ev) = rx.recv().await {
            match ev {
                AgentEvent::Message(t) => println!("{t}"),
                AgentEvent::ToolStart { name, args, .. } => println!("· {name}({args})"),
                AgentEvent::ToolEnd {
                    summary,
                    elapsed_ms,
                    ..
                } => println!("  → {summary} ({elapsed_ms}ms)"),
                AgentEvent::Note(t) => println!("» {t}"),
                AgentEvent::Error(e) => {
                    eprintln!("[error] {e}");
                    failed = true;
                }
                AgentEvent::Done => break,
            }
        }
        let _ = turn.await;
        jobs.kill_all().await;
        if failed {
            std::process::exit(1);
        }
        return;
    }

    let result = tui::run(cfg.model_id.clone(), root, system, llm, tools, mcp_notices).await;
    jobs.kill_all().await;
    if let Err(e) = result {
        eprintln!("agentj: {e}");
        std::process::exit(1);
    }
}
