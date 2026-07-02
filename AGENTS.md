# AGENTS.md — agentj

## What this repo is
- Product: `agentj-rs/` — Rust terminal coding agent with a ratatui TUI and headless `--once` mode.
- Root layer: thin Bun/bash wrappers for build/test/eval convenience; not a separate app.
- Eval harness: `test-projects/` — fixed fixture projects and task runner used to grade agent behavior.
- Historical notes: `docs/` — prior-architecture/design documents, not current build inputs.

## Component map
- `agentj-rs/`
  - Rust crate and only shipped product binary (`agentj-rs/Cargo.toml`, `agentj-rs/src/main.rs`).
  - Key areas:
    - `src/main.rs` — CLI entry; routes to TUI, `--once`, or `mcp` subcommands.
    - `src/agent.rs` — model/tool loop; delegate interception; background-job nudges.
    - `src/tools.rs` — built-in tools, `job_*`, MCP tool routing, repo path confinement.
    - `src/tui/` — full-screen UI (`app.rs`, `view.rs`, `editor.rs`, `keymap.rs`, `markdown.rs`, `knowledge.rs`, `theme.rs`, `mod.rs`).
    - `src/provider/`, `src/model.rs` — provider abstraction and OpenAI-compatible client; Azure/custom wired.
    - `src/mcp/` — `.mcp.json` loading/merge and RMCP client.
    - `src/rekey.rs` — `/task` worktree re-key flow.
    - `tests/pty_input.rs` — PTY integration tests.
- `bin/`
  - `bin/agentj` — symlink-safe bash launcher; builds `agentj-rs/target/release/agentj` on first run.
  - `bin/aj` — short alias to `bin/agentj`.
- `test-projects/`
  - `run.ts` — Bun eval runner.
  - `tasks.jsonc` — task manifest and grading config.
  - Fixtures:
    - `pnpm-vitest-monorepo/` — pnpm workspace fixture.
    - `python-pytest/` — Python/pytest fixture.
    - `go-stdlib/` — Go/std testing fixture.
- `package.json`
  - Convenience scripts only: `agentj`, `build`, `test`, `eval`.
- `README.md`
  - User-facing overview and run/develop commands.

## How the pieces fit together
- `bin/agentj` launches the Rust binary; if missing, it runs `cargo build --release --manifest-path agentj-rs/Cargo.toml` first.
- Root `package.json` mirrors the same build/test/eval commands for Bun users.
- `test-projects/run.ts` copies a fixture to a temp dir, initializes git, runs setup, runs `agentj --once`, then grades with `verify`, `expect`, and/or `expectNoChange` against the baseline commit.
- `docs/` is reference material only; current behavior is defined by the Rust crate and runner code above.

## Agent conventions for this repo
- Work in the real product unless the task is explicitly about the wrapper layer or eval fixtures: `agentj-rs/` is the app.
- Keep changes small and local; do not revive the removed TypeScript product.
- Match existing module boundaries in `agentj-rs/src/`:
  - async/event-loop orchestration in `tui/mod.rs`
  - UI state transitions in `tui/app.rs`
  - rendering in `tui/view.rs`
  - tool definitions in `tools.rs`
- Preserve repo confinement and process-group behavior when changing tools/command execution (`src/tools.rs`, `src/exec.rs`, `src/jobs.rs`).
- Treat `docs/` as historical unless a task explicitly asks to update design notes.
- For eval work, document and preserve objective graders in `test-projects/tasks.jsonc`; do not replace strict checks with prose.

## Verified commands
Ran from repo root:
```sh
cargo build --release --manifest-path agentj-rs/Cargo.toml
cargo test --manifest-path agentj-rs/Cargo.toml
bun test-projects/run.ts --help
```

Convenience equivalents defined in `package.json`:
```sh
bun run build
bun run test
bun run eval
```

Direct launchers:
```sh
bin/agentj
bin/aj
```

## Verification evidence
- `cargo build --release --manifest-path agentj-rs/Cargo.toml` — passed.
- `cargo test --manifest-path agentj-rs/Cargo.toml` — passed: 94 unit tests + 5 PTY integration tests.
- `bun test-projects/run.ts --help` — exits 0 and prints the harness summary banner.
