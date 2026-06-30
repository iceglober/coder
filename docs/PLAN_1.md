# coder — Built

What exists and works today, grouped by area. The thesis is in [PLAN.md](./PLAN.md); the
roadmap is in [PLAN_2.md](./PLAN_2.md). Per-item status detail lives in [TODOS.md](../TODOS.md).

---

## Agent core

- **The loop.** A multi-step tool cycle on the AI SDK's `ToolLoopAgent.generate()`, run
  **non-streaming** — the Vertex streaming path mangles Gemini-3 thought-signatures on
  multi-step tool replay, degrading the model; non-streaming round-trips them. Rendered
  per-step. A guaranteed conclusion: hitting the step ceiling (40, `CODER_MAX_STEPS`) forces a
  final no-tools synthesis so there's always an answer.
- **Orchestration / subagents.** coder decides per task — a cheap `generateObject` triage
  routes *investigate* vs *direct*. An investigation spawns a read-only **investigator** in its
  own isolated context that returns a compact verdict (never its transcript); an **implementer**
  then acts on it. The orchestrator keeps only the verdict + report. Compact prior-turn verdicts
  flow forward as **working memory**, so a follow-up ("resolve the threads on that PR") resolves
  its references instead of starting blind.
- **Roles as toolsets (the keystone).** Every tool/operation declares an `effect`
  (`read | verify | write`). A subagent role is a *filtered view* of the registry by effect
  (`toolsForRole`) — the investigator is read + verify (it can run checks, has no write tools),
  decoupled from permission posture. Read-only means *no edits*, not *no execution*.
- **Permissions.** Per-call `decide → allow / ask / deny`, effect-aware, with posture presets
  (`auto`/`ask`/`auto-edit`/`plan`) + per-tool overrides. `verify` (the project's own checks) is
  allowed even in `plan` — diagnosis isn't mutation; `bash` (arbitrary execution) stays gated on
  its own. Interactive approvals work in-process.
- **Models.** Multi-provider via the AI SDK (Vertex/Gemini default + Anthropic), per-provider
  tier maps, preflight. `/models` lists the catalog and `/model <id>` switches live (persisted).
  Pricing is dynamic from **models.dev** (cached, daily refresh, family-table fallback), priced
  by exact id with the >200k-context tier, and **prompt-cache-aware** (`cacheReadTokens` priced
  at the catalog `cache_read` rate; every turn shows `% cached`). On AI SDK v7.

## Project intelligence

- **Polyglot toolchain detection.** `detectProjectFacts` computes how to run a repo's tasks
  instead of guessing (the npm-vs-pnpm error class): js + python today, a pluggable `Detector`
  registry (a language = one detector). Deterministic, cached, gitignore-respecting. Persisted
  to `.coder/facts.json` as `{computed, overrides}` — human overrides win and survive
  re-detection; written only when changed.
- **The `script` tool.** The agent names a *task* (`script("test")`), and the tool resolves the
  toolchain governing a `path` and runs its exact command — it can never reach for the wrong
  package manager. **Monorepo-aware**: a path inside a workspace package scopes to it
  (`pnpm --filter …`); a single test **file** runs just that file via the package's detected
  runner, bypassing a turbo/wrapper root.
- **Declared + parameterized commands.** Repo-level commands declared in `facts.json` (e.g.
  `checks: "gh pr checks {pr}"`) resolve via `resolveCommand` (declared wins, then toolchain).
  Named placeholders (`{pr}`, `{env}`) are filled from a model-supplied `args` map and
  **shell-quoted** (injection-safe — an untrusted value is one inert token); the `task` name is
  validated against metacharacters. Stack-neutral: works for GitHub/GitLab/CircleCI/self-hosted
  alike, no forge baked in.

## Execution safety

- **Sandbox (P0).** A `CommandRunner` seam: `HostCommandRunner` (default) or a per-worktree
  `DockerSandbox` (bind-mounted worktree, shell via `docker exec`, idempotent lifecycle,
  in-container timeout, hardening: `no-new-privileges`, opt-in non-root + egress cut).
  **Credentials never enter the sandbox** — the model loop is host-side. **Routing by source:**
  when the sandbox is on, untrusted repo code runs in the container while trusted declared
  commands (`gh`, host-authed) run on the host, so isolation doesn't break the forge workflow.
- **OOM guard.** The SDK runs a step's tool calls in parallel; a model asking for several
  `script("test")` at once spawned that many worker pools and OOM'd the host. `script`/`bash`
  share a concurrency gate (default 1 = serial; `CODER_MAX_PARALLEL_COMMANDS` overrides); reads
  stay parallel. The gate sits in the execute wrapper so `tool.start` fires post-acquire — the UI
  shows real serialized execution.
- **Process-group kill.** Commands spawn detached (own process group); abort/timeout kills the
  **whole tree** (bash → turbo → vitest → workers), not just the shell — so Ctrl-C is instant and
  a timeout actually frees the machine. Path confinement (`safeResolve`) rejects `..`/symlink
  escapes on every file tool.
- **Change accountability.** The runner *always* appends a computed `📝 changed N files: …`
  footer from the edit tools — a destructive change can't hide in a forgetful verdict. Carried
  into `RunOnceResult.changedFiles` and the orchestrator's report; the charter requires listing
  changes up front.

## Measurement

- **Receipts.** One append-only `Receipt` per task: effort (turns, tool calls, files,
  `repeatedCalls`, `timeouts`, `toolMs`), cost + cached tokens, model, and the borrowed verdict.
  `/stats` rolls them up (verdict mix, accepted-rate, avg effort, **time-in-tools + timeouts** —
  the wall-clock token cost hides).
- **Verdict (borrowed).** A one-key sign-off at the resolution event (`accepted`/`rejected`/
  `abandoned`/`unknown`), persisted to `verdicts.jsonl`, folded latest-wins. Ctrl-C on an unsigned
  result → `abandoned`. The charter holds every conclusion to the verdict standard.
- **Gates not scores.** A test/typecheck result is a `checks` gate, never the accuracy number.

## Behavior steers (workflow → prompt/triage, evidence-not-exhortation)

- **Ambiguity.** A vague task ("clean up the docs") routes to *direct*; charter + investigator
  ask ONE question or state a bounded interpretation + the smallest change — no guess-and-sweep.
- **Failing-checks.** Establish *which* checks fail first (declared `checks` cmd, else local + a
  stated caveat), fix only those, iterate via single-file test runs.
- **Whole-workspace.** `script`'s result *notes* when a bare `test` ran every package — evidence,
  not exhortation; the guidance lives on the tool, not the charter.
- **Timeout guard.** After a task times out twice, the tool *refuses* a 3rd spawn and returns
  evidence (needs setup / narrower scope) — a deterministic guard, saving the wasted 120s.
- **Thrash + cut-off.** Exact-repeat calls counted (`repeatedCalls`); a step-limit cut-off writes
  a resumable progress note (established / tried / hypothesis / next / **changed**) the
  orchestrator continues from.
- **Legible failures.** The `test_summary` filter keeps the failure block (assertion + `file:line`),
  not just counts, so the model fixes from the result instead of re-running to hunt for "FAIL".

## Deterministic operations & dispatch

- **Registry + built-ins.** `OperationRegistry` with tool/filter surfaces; `git_state`,
  `find_def` (tools) + `test_summary` (bash-output filter) wired into the live loop.
- **Zero-token dispatch.** Explicit slash commands (`/git-state`, `/read <file>`) answered with
  no model/creds/sandbox, confidence-gated. Free-text NL guessing was deliberately removed —
  learned shortcuts are the Distiller's job, from real receipts, not hardcoded hunches.

## Context

- **History compaction.** Older turns summarize past a token threshold while recent ones stay
  verbatim; safe-degrades to full history on summarizer error.

## Interface

- **In-process by default.** `coder` runs the chat in-process (no server); `--once` one-shots;
  `--serve` hosts an HTTP/SSE server; `--connect` attaches. The server emits the full progress
  event stream and has the permission round-trip.
- **Full-screen Ink TUI.** A captive alt-screen layout rendering the same `ServerEvent` stream
  (engine unchanged). **Tabs = concurrent sessions** (own transcript/history/model/sandbox/cost;
  turns run async). **Per-tab live CPU/RSS** sampled from each session's command process group —
  see which tab is eating the machine. Word-wrapped transcript with scroll (Ctrl-U/D), single-key
  `y`/`n` sign-off, per-session `/sandbox` toggle, input history. `--classic` keeps the line
  client. (Markdown render, `/palette`, and docker-tab `docker stats` are roadmap.)
- **Docs site.** `coder-docs`: a dependency-free Bun-served site organized by concept, with a
  **Build status** section read live from `TODOS.md`.
