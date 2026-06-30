# coder — design

The durable thesis and the shape of the system. The concrete requirements live in two
companion docs, split by status:

- **[PLAN_1.md](./PLAN_1.md) — Built.** What exists and works today, grouped by area.
- **[PLAN_2.md](./PLAN_2.md) — Roadmap.** What's next: incomplete but worth doing, fleshed out.

This file is the *why* and the *shape*; it changes slowly. The two companions track *what*.

---

## What it is

coder is a coding agent — same category as Claude Code and Opencode: it talks to you, reads
and writes files in your repo, runs shell commands, and calls a model in a loop until the
task is done. If you've used those, you know the shape.

What's different is what it optimizes for. Most agents spend tokens freely and let the
conversation fill with tool schemas, raw command output, and history. coder treats three
things — **accuracy, token efficiency, and cost** — as constraints built into its primitives,
not features bolted on later. The bet: keep an agent at least as capable while making it
leaner, more accurate, and cheaper — and the savings compound the more you use it.

## Why, honestly

Two reasons, in order:

1. **Accuracy.** Long context makes every current model *worse*, not just slower and pricier —
   measured across 18 frontier models [chroma], plus the classic "lost in the middle" result
   [lim]. Keeping context short and relevant is first an *accuracy* lever. This is the reason
   that stays true.
2. **Cost and speed.** Fewer tokens is cheaper and faster — but token prices keep falling and
   caching cuts input cost further, so this is the secondary benefit. We don't pretend "tokens
   in context = cost" once caching is in play.

We lead with accuracy because it's durable.

## How the agent works

The agent only ever does three things:

- **Think** — call the model. Powerful, non-deterministic, expensive. Last resort.
- **Act** — run a primitive tool: read/write/edit a file, run a shell command, grep. The
  model decides when and how.
- **Compute** — run a deterministic operation: plain code, input → structured output, **no
  model call**.

One rule drives everything: **prefer Compute over Think.** Anything you can work out with
code — the state of a PR, whether tests passed, where a function is defined, which package
manager a repo uses — shouldn't cost a round of model reasoning or dump raw output into the
conversation.

## The one building block: a deterministic operation

"Capabilities" and "Extractors" were the same thing from two angles, so there's one primitive:
a small function, **input → structured output, no model**, with four independent properties.

- **Surface — where it's triggered** (an operation can expose several):
  a **slash command** you type (`/git-state`, zero model tokens) · a **tool** the agent calls
  (cheap — schema + call, no reasoning chain, no raw output) · an automatic **filter** on a
  noisy tool's output (a 500-line test log → "3 failed, here's which" before the model sees it)
  · a **route** the dispatcher matches from intent (zero model tokens).
  *Honesty:* only slash-command and route paths are truly zero-token; the tool path is cheap,
  not free.
- **Locality — where it runs:** **local** (fast, no network, runs anywhere) or **remote**
  (needs network + usually a credential — runs host-side, never in the sandbox, returns a typed
  answer-or-error).
- **Effect — what it does:** `read` (observe) · `verify` (run the project's own checks; no
  source edits) · `write` (edit files or run arbitrary commands). A subagent role is a filtered
  view of the tool registry by effect.
- **Trust — how much we believe it:** built-in (hand-written, trusted) · probation (machine-
  written, shadow-checked) · trusted (earned it). People decide what *exists*; evidence decides
  what's *trusted*.

## Where capabilities live (design heuristics)

The rules we keep re-deriving for *where a new capability goes* — tool-usage vs workflow
steering, model-capabilities-not-vendors, configuration-over-enumeration, roles-as-toolsets,
measure-the-symptom-fix-the-cause, structure-over-hope — live in **[AGENTS.md](../AGENTS.md)**
("Design heuristics") so they're in front of anyone (agent or human) editing the code. They are
the load-bearing taste of the project; read them before adding to it.

## Measurement: the north star

coder does **not** grade its own correctness — no machine check tells you a task was done
*right*. For every task we measure two things: **effort** (turns, tool calls, cost — computed,
always available) and a **verdict** (did the human accept it — *borrowed, never computed*).
Machine checks (tests, typecheck) are **gates, not scores**.

The north star is **time-to-confirmed-resolution**, trending down: getting the user to a
confident *yes* faster *is* the product. To make that yes cheap, every conclusion is a
**verdict** held to a standard — lead with the answer, plain language, point to
`file:line`/output/diff, tag each claim *checked / reasoned / guess*, state what wasn't checked,
and **always list what it changed** (a change the user can't see is one they can't approve).
Full standard + examples: [accuracy.md](./accuracy.md). The rule, unchanged: **never report a
number we can't back up.**

## What it's not (v1)

- Not a hosted/multi-user service; no web UI.
- Not a general chatbot — it's for coding.
- Won't trust a self-written operation without shadow-checking and your approval.
- Won't shorten code, diffs, or structured output to save tokens.
- Won't report an accuracy number it can't back up.
- Won't make sweeping changes on a vague request — it asks or states a bounded interpretation.

## Self-contained

Its own repo and `coder` binary, multi-provider through the Vercel AI SDK, **zero runtime
dependency on glrs**. glrs is reference only — small patterns (worktrees, cost tracking,
tool-output truncation, background jobs) reimplemented clean, never imported. coder owns its
agent loop and the tool-exec cycle; it does not delegate the loop.

## Layout

```
coder/
  bin/coder
  packages/coder-core/     # protocol/types, event-log, shared domain shapes
  packages/coder-server/   # the engine: runner/orchestrator, tools+effects, deterministic
                           #   operations, permissions, project facts, models+catalog,
                           #   context budget, ledger, sandbox, telemetry, Distiller, SSE
  packages/coder-tui/      # full-screen Ink TUI (tabs + per-tab resources) + the line client
  packages/coder-docs/     # a dependency-free docs site (concepts + live build status)
  .coder/                  # (in target repos) facts.json, ledger.jsonl, verdicts.jsonl, operations/
```

## References

- [chroma] Chroma — *Context Rot: How Increasing Input Tokens Impacts LLM Performance*.
  https://www.trychroma.com/research/context-rot
- [lim] Liu et al. — *Lost in the Middle: How Language Models Use Long Contexts*. arXiv:2307.03172.
- [ctx-eng] Anthropic — *Effective context engineering for AI agents*.
  https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- [verb] *Demystify Verbosity Compensation Behavior of Large Language Models*. ACL 2025.
  https://aclanthology.org/2025.uncertainlp-main.14/
