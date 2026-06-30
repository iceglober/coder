# coder — TODOS · Remaining

Incomplete but worth doing, grouped by capability (aligned with [docs/PLAN_2.md](./docs/PLAN_2.md)).
Done work is in [TODOS_1.md](./TODOS_1.md). 🟡 = partial · ⬜ = not started. The **Cut** section
records what we deliberately won't build.

---

## Agent core

- 🟡 **Orchestrator quality**: triage→investigate→implement works mechanically; output quality is model-bound. Needs a feedback loop — verdict-rate *by route* — to tell whether triage routes well, not just that it routes.
- ⬜ **Fuller session memory**: a structured entity memory (PR #, branch, files), a scribe that distills each turn into it, and a reference-resolution pre-step that rewrites "that PR" before a subagent runs.
- ⬜ **Model list hygiene**: `/models` lists unverified MaaS ids (llama/qwen/…) under google-vertex; only Gemini ids are verified through the adapter — mark or filter them.

## Project intelligence

- ⬜ **More detectors**: go/rust/ruby/java behind the same `Detector` registry; per-package scoping for monorepos beyond js.
- ⬜ **Learn the unknowable**: when detection can't compute a command (a `Makefile`, a bespoke script), escalate to a one-shot learner subagent, persist it as a *learned* fact (computed | learned | overridden), and **validate it actually ran** before trusting it.
- ⬜ **Single-test by name**: running one test *by name* needs runner detection (vitest `-t`, pytest `-k`) cached as a script "variant" — build only if file-scope proves insufficient, and as a cached variant, never an arg-append guess.
- ⬜ **Relevance-gate the patterns index**: project pattern memory ships injecting ALL learned patterns each turn (fine for small sets). At scale, gate which patterns inject by relevance to the task — same idea as `find_capability` for operations. Also: ref-drift detection (a moved/renamed `ref`) and per-path (not just repo-wide) patterns.

## Execution safety

- ⬜ **Sandbox, finished**: graceful fallback when no container runtime (warn + host, don't crash); an image matching the repo's detected toolchains (a `node:22` default lacks `uv`).
- ⬜ **Docker-tab resource**: per-tab CPU/RSS for a docker session via `docker stats` (host `ps` can't see the container namespace).
- ⬜ **Config + allow/deny**: `.coder` / `~/.coder` config files with precedence; bash command allow/deny patterns; "always (session)" / "always (save to config)" on an approval prompt.
- ⬜ **Accountability, complete**: a `git diff --stat` before/after snapshot to catch changes made via `bash` (e.g. `prettier --write`) too, not just the edit tools — and attribute them precisely.

## Measurement

- ⬜ **Surface a failed gate**: when `checks.tests:"fail"` or typecheck fails, say so rather than present "done" over a red gate.
- ⬜ **Give coder sight** (Phase 2 stretch): a headless render/screenshot capability for web UI so visual/UX changes self-verify instead of relying on the user's eyes. New dependency + sandbox work; declared/stack-neutral where possible. The prompt-side "say it's unverified" honesty already shipped.
- ⬜ **Close the verdict loop**: the rejection STEER shipped (a rejection now changes the next turn — see TODOS_1). Remaining: **behavioral backfill** (infer accept/reject from the next turn — moved-on = accepted, new-problem-same-artifact = rejected — so verdicts are free, no keypress); the rollup join (verdict-rate *by effort*); file-scoped cross-turn thrash; recording a rejected approach as an anti-pattern.
- ⬜ **Interactive Ctrl-C test**: the abandoned-on-bail path can't be exercised by piping a fake Ctrl-C.

## Context

- 🟡 **Wire the budget**: `assemble` (priority-sort + trim to a token target) + `composition` exist but aren't on the hot path — the runner sends the raw prompt. Needs real per-slice token counts (currently caller-supplied) and **relevance-gated** injection of tools/operations/docs.
- 🟡 **Context meter**: shipped as `ctx prime Nk · sub Nk` (persistent main context vs ephemeral session subagent tokens) using a ~4-char/token estimate. ⬜ swap for a real `ContextComposition` (system / tools / history / facts slice) + "% full" against the model's window.

## Deterministic operations & dispatch

- 🟡 **classify + escalate**: the abstract decision layer is tested, not on the hot path.
- ⬜ **Tier-start + escalate-on-verify**: start a turn on the cheap tier and escalate on a failed verify — deferred until the verify loop exists (starting cheap with no escalation just degrades quality).
- ⬜ **More built-ins**: typecheck/lint output filters as the patterns emerge.
- ⬜ **More slash commands**: `/test`, `/find <symbol>` as they prove useful.
- ⬜ **find_capability + relevance gating**: a meta-tool over a larger operation set — only worth it past the current handful of built-ins.

## Interface

*New (yours) — ✅ subagent collapse + message navigation + styled verdicts shipped as the transcript tree (see TODOS_1); remaining:*
- ⬜ **Multi-line input** *(new)*: Shift+Return inserts a newline; prompts send on Cmd+Return (so plain Return can be the newline).
- ⬜ **Command palette** *(new keybind)*: the `/`-palette opens on Ctrl+P (or Cmd+Shift+P / Cmd+K).
- ✅ **Markdown verdicts + gutters** shipped (see TODOS_1). Remaining styling depth: color the `checked/reasoned/guess` tags + `file:line` refs; span-aware wrapping for bold/code that wraps mid-span.

*Existing:*
- 🟡 **TUI iteration**: markdown + gutters done; remaining — scrollback depth (a real scroll offset, not just nav-tail), persistent status-bar footer (cost + context-fill live), and **Path B** (bordered `<Box>` cards + an Ink-owned scroll viewport — the bigger refactor off the "1 row = 1 line" model).
- ⬜ **Remote transport** (low priority — in-process is the daily driver): reconnect-on-drop, inline approvals over `--connect`, `tool.delta` (meaningless until a tool *streams* output).
- ⬜ **Host↔sandbox handshake**: when the docker sandbox is adopted for untrusted work — the sandbox reaches exactly one privileged thing (the model endpoint) via the host. The piece that makes isolation genuinely credential-safe.

## Output control

- 🟡 **shapeProse / providerControls**: implemented, not wired — apply `shapeProse` to deltas before display + history; pass `providerControls` (verbosity/effort) to the provider call.
- ⬜ **Verbosity → Distiller**: emit verbosity as an OTel metric and feed spikes to the Distiller (not escalation).

## The bets (P3)

- 🟡 **Distiller**: `detectWaste` + `isRoiPositive` exist → structural-signature detection of repeated chains, budgeted synthesis on the cheap tier, replay-validation against fixtures, dedup, emit `Proposal`s.
- ⬜ **Trust / shadow machinery**: probation → trusted via shadow agreement checks; auto-demote on disagreement; replay (code correct) vs shadow (answer right today).
- ⬜ **Remote operations**: `pr_status`, CI `test_results` as typed host-side ops — open question: which genuinely need to be operations vs *declared commands*.
- ⬜ **Notes scratchpad in the loop**: the store exists; the agent doesn't use it yet.

## Telemetry & registry

- 🟡 **OTel + Counted**: exist → spans/metrics around each operation + per-call token/cost via the AI SDK, off until pointed at a backend.
- 🟡 **Registry loaders**: project>global precedence exists → read operation files from disk, validate fixtures + provenance, reconcile live stats from the ledger.

## Cross-cutting

- ⬜ **Drop Anthropic-direct?**: optional if the project goes Gemini-only (kept as opt-in per AGENTS.md).
- ⬜ **README / AGENTS.md updates**: provider auth + sandbox usage as phases land.

---

## Cut — deliberately not building

Recorded so the decision stays made.

- **Worktree create/remove + drift watcher** — glrs owns worktree lifecycle; coder operates *inside* one. Keep only a small **nested-clone guard** at startup.
- **A `Forge` adapter registry** — superseded by *configuration over enumeration* (the repo declares a `checks` command); coder stays forge-agnostic, maintains no vendor zoo.
- **Runtime options beyond Docker** (Podman / Apple container) — the seam exists; add an adapter the day it's wanted, not speculatively.
- **A pinned tmux/pty shell pane** — the in-process pivot makes a captive second pane a large investment for little gain; revisit only on demand.
- **Free-text NL dispatch guessing** — brittle, cut the model out of judgment; removed. Learned shortcuts are the Distiller's job.
