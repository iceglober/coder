# coder

A coding agent — same category as Claude Code and Opencode. It talks to you, reads and
writes files in your repo, runs shell commands, and calls a model in a loop until the task
is done. What's different is what it optimizes for: it **prefers computing over thinking**
and keeps its context short on purpose, because long context makes models *less accurate*,
not just slower and more expensive.

Full design in **[`docs/PLAN.md`](docs/PLAN.md)** · what's built in
**[`docs/PLAN_1.md`](docs/PLAN_1.md)** · roadmap in **[`docs/PLAN_2.md`](docs/PLAN_2.md)**.

## Requirements

- **[Bun](https://bun.sh) 1.2+** — the runtime and package manager. There is no Node build step.
- **A model provider** (pick one): Google Vertex AI (Gemini, default), Anthropic (Claude),
  or Azure AI Foundry. See [Set up a provider](#set-up-a-provider).
- **git** — used to run each tab in its own worktree (see [Isolation](#isolation-worktrees-tabs-and-the-sandbox)); without a git repo, coder runs in place.
- **A Docker-compatible daemon** *(optional)* — only for `--sandbox docker`. Docker Desktop or
  [colima](https://github.com/abiosoft/colima) both work; the `docker` CLI must be on your PATH.

## Install

```sh
git clone https://github.com/iceglober/coder
cd coder
bun install
bun bin/coder --help
```

## Set up a provider

coder runs a **preflight** credential check before each task and tells you exactly what's
missing rather than failing mid-stream.

**Vertex / Gemini (default)** — authenticate once, then point coder at your project:

```sh
gcloud auth application-default login
export GOOGLE_VERTEX_PROJECT=your-gcp-project-id
export GOOGLE_VERTEX_LOCATION=global   # optional; "global" serves every Gemini model
```

**Anthropic / Claude** — set a key and select the provider per run (or via `CODER_PROVIDER`):

```sh
export ANTHROPIC_API_KEY=sk-ant-...
bun bin/coder --provider anthropic
```

**Azure AI Foundry** — coder talks to Foundry's OpenAI-compatible endpoint. Azure addresses
models by the **deployment name you choose**, so there's no default — you must name one with
`--model` / `CODER_MODEL`:

```sh
export AZURE_BASE_URL=https://<resource>.services.ai.azure.com/models
export AZURE_API_KEY=...
export AZURE_API_VERSION=2024-10-21    # optional; some endpoints require it
bun bin/coder --provider azure --model <your-deployment-name>
```

## Run it

`bun bin/coder` (or `bun run coder`) launches the full-screen TUI in the current git repo.
The agent runs **in-process** by default — no server, no port.

```sh
bun bin/coder                          # interactive chat (current repo)
bun bin/coder --once "add a --json flag to the export command"   # run one task, then exit
bun bin/coder --once "why does the build fail?" --investigate    # read-only diagnosis, no edits
bun bin/coder --classic                # line-based client instead of the full-screen TUI
```

The TUI is **tabbed** — each tab is an independent session (own transcript, model, cost, and
worktree), and turns run concurrently:

| Key | Action |
|---|---|
| `Ctrl-T` | new tab (creates its own worktree) |
| `Ctrl-N` / `Ctrl-P` | next / previous tab |
| `Ctrl-W` | close tab |
| `Esc` | toggle transcript navigation (↑/↓ scroll, Enter expand a group) |
| `Ctrl-C` | abort the running turn, or exit when idle |

### Options

| Flag | Values | Default | Env |
|---|---|---|---|
| `--tier` | `cheap` `fast` `mid` `deep` | `mid` | `CODER_TIER` |
| `--model` | exact model id (overrides tier) | — | `CODER_MODEL` |
| `--provider` | `vertex` `anthropic` `azure` | `vertex` | `CODER_PROVIDER` |
| `--sandbox` | `host` `docker` | `host` | `CODER_SANDBOX` |
| `--mode` | `auto` `ask` `auto-edit` `plan` | `auto` | `CODER_PERMISSION_MODE` |
| `--worktree` | (flag) isolate a `--once`/`--classic` run in one throwaway worktree | off | — |
| `--port` | port (with `--serve`) | `4123` | `CODER_PORT` |
| `--bearer` | auth token (`--serve`/`--connect`) | `dev` | `CODER_BEARER` |

Tiers map to concrete models per provider — e.g. on Vertex, `mid` is `gemini-2.5-flash`
and `deep` is `gemini-2.5-pro`; on Anthropic, `mid` is Sonnet and `deep` is Opus. Azure has
no tier map (name a deployment with `--model`).

### Permission modes

The agent decides per call whether to **allow / ask / deny**, based on each tool's effect
(`read` / `verify` / `write`).

- `auto` (default) — runs edits and shell without asking.
- `ask` — confirms before edits and shell.
- `auto-edit` — edits freely, but still asks before running arbitrary `bash`.
- `plan` — read-only; allows the project's own checks (typecheck/test) but no edits and no
  raw `bash`. Diagnosis isn't mutation.

## Isolation: worktrees, tabs, and the sandbox

coder isolates work at **two independent layers**. They're easy to confuse, so here's the
split:

- **Worktrees isolate files** — *which checkout the agent edits.*
- **The sandbox isolates process execution** — *where shell commands run.*

You can use either, both, or neither. They compose.

### Worktrees (file isolation) — on by default

A **git worktree** is a second checkout of your repo on its own branch, in its own directory.
coder runs **every tab in its own worktree** so the agent never edits your live checkout:

- Each tab gets a throwaway branch `coder/wt-<id>` off `HEAD`, checked out under
  `~/.coder/worktrees/<repo>/<branch>`. The status line shows the tab's branch and CWD.
- Because the worktree is branched off `HEAD`, **uncommitted changes in your checkout are not
  carried in** — the tab tells you when that's the case.
- **Smart reap on exit:** a tab that changed nothing has its worktree deleted entirely (branch
  and all). A tab that did work gets its uncommitted changes committed as a WIP snapshot, its
  directory removed, and its **branch kept** — coder prints the kept branches so you can review,
  merge, or delete them. Nothing you did is lost; no empty directories pile up.
- **Fallback:** if a worktree can't be made (not a git repo, or coder was launched *inside* a
  linked worktree) the tab runs in place on your current checkout, with a visible note.
- `coder --worktree` does the same for a non-TUI run (`--once` / `--classic`): it isolates that
  one run in a single worktree, kept for review.

### The sandbox (process isolation) — opt-in

By default (`--sandbox host`) the agent's shell commands run **directly on your machine**. With
`--sandbox docker`, they run **inside a container** instead:

- coder starts a container (default image `node:22-bookworm`) with the tab's worktree
  **bind-mounted** at `/workspace`, and runs commands via `docker exec`. Each worktree gets its
  own container; it's created for the run and removed when the turn ends — nothing persists.
- **Only process execution is isolated.** File tools (read/write/edit) act on the host worktree
  path directly — the same files, bind-mounted — so edits are immediately visible to you on the
  host. Shell commands (`bash`, tests/build/lint, grep, `run_code`) run in the container.
- **Credentials never enter the container.** The model API calls stay host-side, and so do
  **trusted declared commands** — anything you declared in `.coder/facts.json` (e.g.
  `gh pr checks`, which needs your host login). Untrusted repo code runs in the container;
  host-authed commands run on the host, so isolation doesn't break your GitHub/CI workflow.
- **Hardening:** `--security-opt no-new-privileges` always; opt in to a non-root user
  (`CODER_SANDBOX_USER`) and to cutting network egress (`CODER_SANDBOX_NETWORK=none`).

| Env | Effect |
|---|---|
| `CODER_SANDBOX=docker` | turn the sandbox on (same as `--sandbox docker`) |
| `CODER_SANDBOX_IMAGE` | container image (default `node:22-bookworm`) |
| `CODER_SANDBOX_USER` | run commands as this user/`uid:gid` (default: image default) |
| `CODER_SANDBOX_NETWORK` | `docker run --network` value, e.g. `none` to cut egress |

> **colima / macOS:** the worktree must live under a path colima mounts (your home dir by
> default). Per-tab worktrees live under `~/.coder/worktrees/…`, so they're covered. coder
> verifies the bind mount on startup and prints the exact `colima --mount` fix if it's empty.

## In the chat

Slash commands run with **zero model tokens**:

- `/stats` — task receipts rolled up: cost, verdict mix, avg effort, time-in-tools.
- `/models` — list the model catalog; `/model <id>` switches live (persisted).
- `/facts` — show the detected toolchain facts for this tab's repo.
- `/sandbox` — toggle this tab between host and docker.
- `/exit` (or `/quit`) — leave.

When a task finishes, **sign off** so receipts stay honest: `y` = accepted, `n` = rejected.
Ctrl-C on an unsigned result records it as abandoned. *(The `--classic` line client uses the
same commands, with `/y` `/n` `/skip` for sign-off.)*

## Per-repo config: `.coder/facts.json`

coder detects how to run *your* repo instead of guessing — package manager, test/build/lint
commands, and monorepo workspace layout (JavaScript, Python, and Go today, via a pluggable
detector registry). It caches the result in `.coder/facts.json`:

```jsonc
{
  "computed": { "toolchains": [ /* auto-detected; do not edit */ ] },
  "overrides": {},          // your corrections — these win and survive re-detection
  "commands": {             // declare repo-specific commands the agent can call
    "checks": "gh pr checks {pr}"   // {pr} is filled by the agent and shell-quoted (injection-safe)
  }
}
```

The agent calls commands by *task name* (`script("test")`, `script("checks", {pr: 42})`),
so it can never reach for the wrong package manager. A path inside a workspace package
scopes the run to that package; naming a single test file runs just that file. Declared
commands are also the ones that stay on the host when the sandbox is on (see above).

coder also writes runtime state under `.coder/` in the target repo — `proposals/`,
`fixtures/`, `*.jsonl` receipts/verdicts. Those are gitignored by default.

## MCP servers (Linear, etc.)

coder connects to [MCP](https://modelcontextprotocol.io) servers and exposes their tools to the
agent. It reads **Claude Code's `.mcp.json` format**, so an existing config works unchanged — a
repo `.mcp.json` (project root) merged over a global `~/.coder/.mcp.json` (repo wins):

```jsonc
{
  "mcpServers": {
    "linear":  { "type": "http", "url": "https://mcp.linear.app/mcp" },         // OAuth (browser)
    "github":  { "type": "http", "url": "https://api.githubcopilot.com/mcp/",
                 "headers": { "Authorization": "Bearer ${GITHUB_MCP_TOKEN}" } }, // static token
    "local":   { "command": "npx", "args": ["-y", "some-mcp-server"] }           // stdio
  }
}
```

- **stdio** (`command`/`args`/`env`), **remote** (`type: "http"|"sse"`, `url`, `headers`). String
  values support `${VAR}` / `${VAR:-default}` expansion — that's how you supply tokens.
- **OAuth** servers (like Linear) authenticate the same way Claude Code does: dynamic registration
  (no app to create) + browser, tokens stored in `~/.coder/auth.json` and refreshed automatically.
  When a configured server needs auth, coder **prompts you in-session** — *Authorize "linear" in your
  browser? (y/n)* — and runs the flow without restarting; the tools become available in the same
  turn. You can also do it up front with **`coder mcp login linear`**. A server with a static
  `Authorization` header skips OAuth. `coder mcp list` shows status; `coder mcp logout <name>` forgets
  the tokens.
- Tools appear to the agent as `<server>__<tool>` (e.g. `linear__create_issue`). They carry the
  **`write` effect** — so they obey permission modes (e.g. `--mode plan` refuses them) and the
  read-only investigator never calls them.
- A server that needs login (or fails to connect) is skipped with a warning naming it; the run
  continues. **Cost note:** every configured server's tools are injected each run, and MCP tool
  schemas are large (~550–1,400 tokens each) — relevance-gating them is a planned follow-up.

## Remote / multi-process

The agent can run behind an HTTP/SSE server when the UI and engine live in different
processes (isolated container, remote host, multiple clients):

```sh
bun bin/coder --serve --port 4123 --bearer <token>           # host the agent server
bun bin/coder --connect http://host:4123 --bearer <token>    # attach a client (chat, or with --once)
```

## Layout

```
coder/
  bin/coder                # binary entry — launches the TUI client
  packages/coder-core/     # protocol/types, worktree+git glue, event-log, loaders
  packages/coder-server/   # agent loop, tools, deterministic operations, toolchain
                           #   detection, permissions, sandbox, ledger, telemetry
  packages/coder-tui/      # terminal UI: full-screen Ink TUI + classic line client
  packages/coder-docs/     # dependency-free docs site (bun-served)
  test-projects/           # eval harness — fixed projects + tasks coder is run against
  docs/                    # PLAN (design) · PLAN_1 (built) · PLAN_2 (roadmap)
```

## Develop

Root scripts fan out to every package:

```sh
bun run typecheck
bun run test
bun run lint
bun run build
```

**Eval harness** — run coder against a fixed set of real tasks (pnpm-vitest / pytest / go),
each in an isolated throwaway copy, graded objectively (a `verify` command must exit 0, an
`expect` fact must appear, or an LLM judge scores an open-ended design). Needs Vertex creds.

```sh
bun test-projects/run.ts          # all tasks
bun test-projects/run.ts py       # only tasks whose id contains "py"
KEEP=1 bun test-projects/run.ts   # keep the throwaway dirs to inspect the diff
```

See [`test-projects/README.md`](test-projects/README.md) for how to add a project or task.

Useful env knobs: `CODER_MAX_STEPS` (loop ceiling, default 40),
`CODER_MAX_PARALLEL_COMMANDS` (shell concurrency gate, default 1 = serial).

## License

MIT — see [LICENSE](LICENSE). Self-contained; multi-provider via the Vercel AI SDK,
zero runtime `glrs` dependency.
