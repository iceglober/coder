# agentj-rs — the agentj crate (ratatui edition)

**This is agentj.** A Rust terminal coding agent with a full-screen **ratatui** UI. It began as a port
of a now-retired TypeScript implementation (the `TS` column below is that reference); the TS package was
removed in the Rust cutover, so this crate is the product.

```sh
cd agentj-rs
cargo build
cargo run -- --help
cargo run -- --once "add a --json flag and run the tests"   # headless
cargo run                                                    # full-screen ratatui chat
```

## Why it's a reimplementation, not a transliteration

The TS version leans entirely on the Vercel AI SDK (`ai` / `@ai-sdk/*`). There's no equivalent in
Rust, so the provider HTTP clients, the tool-call loop, and structured output are hand-written
(reqwest + serde). And ratatui is full-screen/immediate-mode, so the UI *replicates the behavior*
(streaming transcript, tool lines, spinner/status, `/task`, slash highlight + Tab completion, Ctrl-C)
in a proper full-screen layout rather than the TS inline-scroll model.

## Parity status

| Area | TS (`packages/agentj`) | Rust (`agentj-rs`) |
|---|---|---|
| Full-screen TUI + streaming transcript | inline raw-ANSI | ✅ ratatui |
| Slash-command highlight + Tab completion | ✅ | ✅ (`commands.rs`, tested) |
| `/task` LRW re-key (wipe → fetch → checkout) | ✅ | ✅ (`rekey.rs`, tested) |
| Built-in tools (read/write/edit/ls/glob/grep/bash) | ✅ | ✅ (`tools.rs`) |
| Process-group command runner (kill the tree) | ✅ | ✅ (`exec.rs`, `process_group` + killpg) |
| Tool-call loop, non-streaming | ✅ | ✅ (`agent.rs`) |
| System prompt (identity/context/instructions) | ✅ | ✅ (`prompt.rs`) |
| **OpenAI-compatible provider (Azure / custom)** | ✅ | ✅ (`provider/openai.rs`) |
| Vertex (Gemini) provider | ✅ | ⏳ stage 2 |
| Anthropic provider | ✅ | ⏳ stage 2 |
| MCP tools (stdio + no-auth http) | ✅ | ✅ (`mcp/*` via `rmcp`; config tested) |
| MCP static-header / OAuth | ✅ | ⏳ staged |
| Supervised auto-continue | ✅ | ⏳ stage 2 (`finish_reason` already plumbed) |
| **Subagents** — parallel `delegate` (DAG execution) | — | ✅ Rust-first (`subagent.rs` + `agent.rs`) |
| **Background jobs** — non-blocking + nudges | — | ✅ Rust-first (`jobs.rs`, tested) |
| **SPEAR instructions** (Scope/Plan/Execute/Assess/Resolve) | — | ✅ Rust-first (`prompt.rs`) |

## Run against Azure (what's wired)

```sh
AZURE_BASE_URL=https://<resource>.openai.azure.com/openai/v1 \
AZURE_API_KEY=… \
cargo run -- --provider azure --model gpt-5.4
```

Env knobs mirror the TS side: `AGENTJ_PROVIDER`, `AGENTJ_MODEL`, `AGENTJ_BASE_URL`, `AGENTJ_API_KEY`,
`AGENTJ_MAX_STEPS`, `AGENTJ_COMPANY`, `AGENTJ_ALLOW_PRIMARY`.

## Verified / not

- **Verified here:** `cargo build` warning-clean, `cargo test` (5 tests: highlight/completion, ref
  classification, provider preflight), `--help` / `--version` / preflight error paths.
- **Not verified here:** a live model turn (needs Azure creds) and the interactive TUI (needs a real
  TTY — `enable_raw_mode` won't run under a pipe). Same caveats as the TS provider paths.
