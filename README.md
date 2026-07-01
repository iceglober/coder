# agentj

A simple, effective terminal coding agent — same category as Claude Code and Opencode. It reads and
writes files in your repo, runs shell commands, and calls a model in a loop until the task is done. It
works directly in your current checkout (or a dedicated worktree via `/task`), and **you** own git as
the safety net.

The product is a **Rust crate with a full-screen [ratatui](https://ratatui.rs) UI**, in
[`agentj-rs/`](agentj-rs/). (An earlier TypeScript implementation was retired in favor of this one.)

## Requirements

- **Rust** (stable, 2021 edition) — `cargo` on your PATH. There's no separate install step; the
  `bin/agentj` launcher builds the release binary on first run.
- **A model provider.** Wired today: **Azure AI Foundry** and any **OpenAI-compatible** endpoint
  (`custom`). Vertex (Gemini) and Anthropic are **staged** (see [Providers](#providers)).
- **git** — used by `/task`, and to scope `glob`/`grep` to non-ignored files.
- **[Bun](https://bun.sh)** *(optional)* — only for the eval harness in `test-projects/`.

## Run it

```sh
git clone https://github.com/iceglober/coder && cd coder     # repo dir is still `coder`
bin/agentj                                   # interactive chat (builds on first run), current repo
bin/agentj --once "add a --json flag and run the tests"      # one task, headless, then exit
bin/aj                                        # short alias
```

- **Full-screen TUI:** streaming transcript + tool lines, a spinner/status line, slash-command
  highlight + Tab completion, multi-line input (Enter submits; Shift/Ctrl+Enter or Ctrl-J = newline;
  arrows move the cursor). **Ctrl-C** interrupts a turn; **Ctrl-D** or `/exit` quits.
- **Permissions are auto** — it edits and runs commands without prompting; you own git.

## Providers

```sh
# Azure AI Foundry (OpenAI-compatible). Name the deployment with --model.
AZURE_BASE_URL=https://<resource>.openai.azure.com/openai/v1 AZURE_API_KEY=… \
  bin/agentj --provider azure --model <deployment>

# Any OpenAI-compatible endpoint (Bifrost, a local server, …).
bin/agentj --provider custom --base-url http://localhost:8080/v1 --model <id>   # + optional AGENTJ_API_KEY
```

| Flag | Values | Env |
|---|---|---|
| `--provider` | `azure` `custom` (wired) · `vertex` `anthropic` (staged) | `AGENTJ_PROVIDER` |
| `--model` | model / deployment id (required for azure & custom) | `AGENTJ_MODEL` |
| `--base-url` | endpoint for `--provider custom` | `AGENTJ_BASE_URL` |

> **Vertex (Gemini) and Anthropic aren't wired in the Rust edition yet** — `--provider vertex` reports
> that it's staged. If those are your daily driver, wiring them is the top follow-up.

Tuning env: `AGENTJ_MAX_STEPS` (step window, default 40), `AGENTJ_MAX_IDLE_NUDGES`,
`AGENTJ_MAX_PARALLEL_SUBAGENTS`, `AGENTJ_STEER_MODEL`, `AGENTJ_COMPANY`.

## What it can do

- **Built-in tools:** `read_file`, `write_file`, `edit_file`, `list_dir`, `glob`, `grep`, `bash`
  (confined to the repo root; `bash` runs in its own process group so Ctrl-C/timeout kills the tree).
- **`/task <pr|branch>`** — long-running-worktree re-key: wipe the worktree, fetch, and re-point it at a
  clean base from origin (PR checkout / existing branch / new branch off origin/main). Gated to a
  dedicated worktree so it can't wipe your primary checkout.
- **Subagents** — `delegate` runs sub-tasks in **parallel** (DAG execution); only each result re-enters
  the main context, so the primary loop stays small.
- **Background jobs** — `job_start`/`job_check`/`job_stop` run long commands non-blocking; the agent is
  nudged when they finish or after a fallback timeout, and keeps working meanwhile.
- **MCP** — reads Claude Code's `.mcp.json` (repo over `~/.agentj/.mcp.json`, `${VAR}` expansion) and
  merges each server's tools as `<server>__<tool>`. Works for **stdio** + **no-auth streamable-http**
  today; static-`Authorization`-header and OAuth are staged. `bin/agentj mcp list` shows what's
  configured.
- **SPEAR prompt** — Scope → Plan → Execute → Assess → Resolve, with branch-first safety and
  "prove it with hard evidence" completion.

## Layout

```
agentj/                     # (repo dir is `coder`)
  bin/agentj, bin/aj        # bash launchers → the Rust release binary (build on first run)
  agentj-rs/                # THE PRODUCT — Rust crate (see agentj-rs/README.md for the module map)
    src/{main,tui,agent,tools,exec,rekey,model,prompt,commands,events,jobs,subagent}.rs
    src/provider/*, src/mcp/*
  test-projects/            # eval harness (bun): fixed projects + tasks, objectively graded
  docs/                     # historical design notes (a prior architecture)
```

## Develop

```sh
cargo build --release --manifest-path agentj-rs/Cargo.toml   # or: bun run build
cargo test  --manifest-path agentj-rs/Cargo.toml             # or: bun run test
bun test-projects/run.ts                                     # or: bun run eval  (needs Vertex creds)
```

The eval harness copies each fixture to a throwaway dir, runs `bin/agentj --once`, and grades on
`verify` (a command exits 0), `expect` (substrings), or `expectNoChange`. The open-ended LLM `judge`
grader is temporarily disabled (it depended on the removed TS judge); architect tasks grade on
`verify` alone until a Rust judge lands.

## License

MIT — see [LICENSE](LICENSE). Self-contained; multi-provider via hand-rolled HTTP (reqwest) + `rmcp`.
