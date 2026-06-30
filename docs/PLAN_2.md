# coder — Roadmap

Incomplete but worth doing, grouped the same way as [PLAN_1.md](./PLAN_1.md). The thesis is in
[PLAN.md](./PLAN.md). The **Cut** section at the end records what we deliberately *won't* build
(over-engineered or superseded) so it stays decided.

---

## Agent core

- **Fuller session memory.** Today's working memory is the compact prior-turn verdicts. The
  richer version: a structured **entity memory** (the PR #, branch, files in play), a **scribe**
  that distills each turn into it, and a **reference-resolution** pre-step that rewrites "that PR"
  to a self-contained instruction before a subagent runs.
- **Orchestrator quality.** Triage→investigate→implement works mechanically; output quality is
  model-bound. Needs a feedback loop (verdict-rate by route) to tell whether triage is routing
  well, not just that it routes.

## Project intelligence

- **More detectors.** go, rust, ruby, java behind the same `Detector` registry; per-package
  scoping for monorepos beyond js.
- **Learn the unknowable.** When detection can't compute a command (a `Makefile`, a bespoke
  script), escalate to a one-shot learner subagent that proposes it, persist it as a *learned*
  fact (computed | learned | overridden), and **validate it actually ran** before trusting it.
- **Single-test by name.** File-scoping covers the 80%; running one test *by name* needs runner
  detection (vitest `-t`, pytest `-k`) cached as a script "variant" — build it only if file-scope
  proves insufficient, and as a cached variant, never an arg-append guess.

## Execution safety

- **Sandbox, finished.** When flipped on: graceful fallback if no container runtime (warn +
  host, don't crash), and an image that matches the repo's detected toolchains (a `node:22`
  default has no `uv`). Per-tab resource for a docker tab via `docker stats` (host `ps` can't see
  the container namespace).
- **Config + allow/deny.** `.coder` / `~/.coder` config files with precedence; bash command
  allow/deny patterns; "always (session)" / "always (save to config)" on an approval prompt.
- **Accountability, complete.** The change footer catches the edit tools; a `git diff --stat`
  before/after snapshot would catch changes made via `bash` (e.g. `prettier --write`) too, and
  attribute them precisely.

## Measurement

- **Surface a failed gate.** When `checks.tests:"fail"` (or typecheck fails), make coder say so
  rather than present "done" over a red gate.
- **Close the verdict loop.** Behavior backfill (acted-on / moved-on = accepted; rephrased /
  pushed-back = rejected) and the rollup join — verdict-rate *by effort*, so we can see whether
  cheaper routes hold quality.

## Context

- **Wire the budget.** `assemble` (priority-sort + trim to a token target) and `composition`
  exist but aren't on the hot path — the runner sends the raw prompt with no per-slice budget.
  Needs real per-slice token counts (currently caller-supplied) and **relevance-gated** injection
  of tools/operations/docs.
- **Context meter.** Compute a real `ContextComposition` (system / tools / history / facts slice)
  and show "context 38% full" in the TUI status bar — the budget coder is built around, made
  visible. (The one server item that's genuinely on-thesis.)

## Interface

- **TUI polish.** Markdown rendering (the assistant gutter + code blocks), a `/`-command
  **palette**, multiline input, a persistent status-bar footer (cost + context-fill live).
- **Remote transport** (low priority — in-process is the daily driver): reconnect-on-drop (the
  server already replays history on connect), inline approvals over `--connect` (in-process
  already prompts), `tool.delta` (meaningless until a tool *streams* output).
- **Host↔sandbox handshake.** When the docker sandbox is adopted for untrusted work: the sandbox
  reaches exactly one privileged thing (the model endpoint) via the host — the piece that makes
  isolation genuinely credential-safe.

## Output control

- Apply `shapeProse` to deltas before display and before they re-enter history; pass
  `providerControls` (verbosity/effort) to the provider call; emit verbosity as an OTel metric
  and feed spikes to the Distiller (not escalation). The pieces exist; none are wired.

## The bets (P3)

- **Distiller.** `detectWaste` + `isRoiPositive` exist. Remaining: structural-signature detection
  of repeated chains, budgeted synthesis on the cheap tier, replay-validation against recorded
  fixtures, dedup against existing operations, and emitting `Proposal`s. The self-improvement loop
  — inference paid for once becomes computation, free forever.
- **Trust / shadow machinery.** Probation → trusted via shadow agreement checks; auto-demote on
  disagreement; replay fixtures for "the code is correct" vs shadow for "the answer is right today".
- **Remote operations.** `pr_status`, CI `test_results` as typed host-side ops — though much of
  this is now covered by *declared commands*, so the open question is which genuinely need to be
  operations vs config.
- **Relevance-gating + `find_capability`.** A meta-tool over a larger operation set, gated by
  relevance — only worth it once there are many more than the current handful of built-ins.
- **Notes scratchpad** wired into the loop (the store exists; the agent doesn't use it yet).
- **Registry loaders.** Read operation files from disk, validate fixtures + provenance, reconcile
  live stats from the ledger.

## Telemetry

- OTel spans/metrics around each operation + per-call token/cost via the AI SDK; off until pointed
  at a backend. Privacy-first product analytics (opt-out, never code or prompts).

---

## Cut — deliberately not building

Recorded so the decision stays made.

- **Worktree create/remove — REVERSED (now built).** Originally cut to glrs. Reversed because coder
  needs *self-contained* isolated runs — a throwaway branch per run via `coder --worktree`, and the eval
  harness runs each task in its own worktree — and neither should depend on glrs being present.
  `createWorktree`/`removeWorktree`/`assertPrimaryClone` (the nested-clone guard) live in
  `coder-core/src/worktree.ts` (plain `git worktree`, no glrs import). The **drift watcher** + per-worktree
  container/tmux pinning stay cut (revisit on demand).
- **A `Forge` adapter registry** (github/gitlab/… adapters). Superseded by *configuration over
  enumeration* — the repo declares a `checks` command; coder stays forge-agnostic and maintains
  no vendor zoo.
- **Runtime options beyond Docker** (Podman / Apple container). The `CommandRunner` seam exists;
  add an adapter the day it's actually wanted, not speculatively.
- **Free-text NL dispatch guessing.** Hand-written intent matchers were brittle and cut the model
  out of judgment on a hunch — removed. Learned shortcuts are the Distiller's job.
- **A pinned tmux/pty shell pane + slash-command shell.** The in-process pivot makes a captive
  second pane a large investment for little gain; revisit only on explicit demand.
