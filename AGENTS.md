# AGENTS.md — agentj

Guidance for agents (and humans) working in this repo.

## What this is

`agentj` is a simple, self-contained terminal coding agent — same category as Claude Code / Opencode.
The product is a **Rust crate with a full-screen ratatui UI**, in `agentj-rs/`. It reads/writes files,
runs commands, and calls a model in a loop until the task is done. Guiding principle: **make it work
and keep it small.** (An earlier TypeScript implementation was retired in the Rust cutover; historical
design notes live in `docs/`.)

## How it fits together (`agentj-rs/src/`)

- `main.rs` — CLI entry: flags, the `mcp` subcommand, then `--once` (headless) or the ratatui chat.
- `tui.rs` — the interactive full-screen loop: transcript / status / input panes, slash highlight +
  Tab completion, a cursor-tracked multi-line editor, `/task` re-key, Ctrl-C to interrupt.
- `agent.rs` — the model loop (`run_turn`). Non-streaming: call the model, run its tool calls, repeat.
  Two extras layered on: **background-job nudging** (drain finished/timeout nudges each iteration;
  idle-wait only when there's nothing else to do) and **`delegate`** interception (subagents).
- `subagent.rs` — the subagent prompt; `delegate` runs sub-tasks in parallel via a `JoinSet`
  (bounded), depth cap 1, forwarding dim `↳[i]` progress; only results re-enter the parent context.
- `jobs.rs` — `JobManager`: background commands in their own process group, capped output buffers,
  finish/timeout nudges.
- `tools.rs` — built-in tools (`read_file`/`write_file`/`edit_file`/`list_dir`/`glob`/`grep`/`bash`),
  the `job_*` tools, MCP routing, and `tool_specs`. Tools return strings and never error out.
- `exec.rs` — the command runner: detached process group so Ctrl-C/timeout kills the whole tree.
- `model.rs` — provider resolution + preflight (azure/custom wired; vertex/anthropic staged).
- `provider/` — the `Llm` enum + the OpenAI-compatible client.
- `mcp/` — `.mcp.json` config (`config.rs`, pure + tested) + an `rmcp` client (`client.rs`).
- `prompt.rs` — the SPEAR system prompt. `rekey.rs` — `/task` LRW logic. `commands.rs` / `events.rs`.

## Conventions

- **Self-contained; no runtime dep on `glrs`.** Reimplement small patterns clean, never import.
- **Non-streaming loop on purpose** (Vertex mangles Gemini thought-signatures on streamed tool replay).
- **Permissions are auto** — every tool call proceeds; the user owns git as the safety net.
- **Path confinement** — file tools resolve through `safe_resolve`, rejecting `..`/symlink escapes.
- **Tools never error out** — a failure returns a string the model can read and react to.
- **Branch-first (SPEAR Scope)** — get on the intended branch/PR before changing anything; if you
  can't, STOP and report, never edit the wrong branch.

## Repo conventions

- The product builds with `cargo` (edition 2021). `bin/agentj` / `bin/aj` are bash launchers that build
  the release binary on first run, then exec it.
- `cargo build --release --manifest-path agentj-rs/Cargo.toml` (or `bun run build`);
  `cargo test --manifest-path agentj-rs/Cargo.toml` (or `bun run test`). Keep the build **warning-clean**.
- `test-projects/` is a bun eval harness (`bun test-projects/run.ts`). It drives `bin/agentj --once`.
- Keep additions small and justified — the agent should stay simple enough to reason about in one sitting.
