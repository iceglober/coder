# AGENTS.md — agentj-rs

## Scope
`agentj-rs/` is the product crate. Build and test it from this directory with Cargo; root-level Bun files are wrappers around these commands.

## Entry points and module map
- `src/main.rs` — CLI entry, config/model preflight, MCP startup, routes to:
  - default full-screen TUI
  - `--once <task>` headless execution
  - `mcp list|login|logout`
- `src/agent.rs` — non-streaming model/tool loop; replays tool calls, handles `delegate`, emits events, and integrates background-job nudges.
- `src/tools.rs` — built-in tools: `read_file`, `write_file`, `edit_file`, `list_dir`, `glob`, `grep`, `bash`, `job_start`, `job_check`, `job_stop`; MCP tool passthrough lives here too.
- `src/tui/`
  - `app.rs` — UI state transitions; returns `AppEffect` for anything async.
  - `mod.rs` — outer event loop / async orchestration.
  - `view.rs` — rendering.
  - `editor.rs`, `keymap.rs`, `markdown.rs`, `theme.rs` — input/render helpers.
  - `knowledge.rs` — `/init` and `/knowledge` snapshot/diff workflow.
- `src/provider/`, `src/model.rs` — provider abstraction and OpenAI-compatible client; Azure/custom are wired, Vertex/Anthropic staged.
- `src/mcp/` — `.mcp.json` loading/merge and RMCP client.
- `src/rekey.rs` — `/task` worktree re-key git flow.
- `src/jobs.rs` — background command manager and nudge queue.
- `src/exec.rs` — process-group command runner.
- `tests/pty_input.rs` — PTY integration coverage for interactive input behavior.

## Local conventions
- Non-streaming loop is intentional; do not switch behavior casually.
- Keep TUI boundaries intact:
  - state/update logic in `tui/app.rs`
  - await/orchestration in `tui/mod.rs`
  - drawing in `tui/view.rs`
- `delegate` is a first-class feature here:
  - parent interception is in `src/agent.rs`
  - subagent prompt is in `src/subagent.rs`
  - depth is capped; subagents do not re-delegate.
- Tool calls return user/model-readable text plus structured success (`ToolOutcome { text, ok }`); do not reintroduce ad hoc error sniffing.
- File tools must stay confined to repo-relative safe paths; preserve `safe_resolve` semantics.
- Command execution and background jobs must keep process-group kill behavior so interrupts/timeouts kill descendants.
- Config is resolved once at startup (`src/config.rs`); avoid dynamic rereads unless the task explicitly requires it.
- Slash commands are centrally defined in `src/commands.rs`; keep completion/highlighting and execution in sync through that registry.

## Verified commands
Ran from repo root against this crate:
```sh
cargo build --release --manifest-path agentj-rs/Cargo.toml
cargo test --manifest-path agentj-rs/Cargo.toml
```

Useful crate-local equivalents:
```sh
cd agentj-rs
cargo build
cargo run -- --help
cargo run -- --once "add a --json flag and run the tests"
cargo run
```

## Verification evidence
- `cargo build --release --manifest-path agentj-rs/Cargo.toml` — passed.
- `cargo test --manifest-path agentj-rs/Cargo.toml` — passed: 94 unit tests + 5 PTY integration tests.
