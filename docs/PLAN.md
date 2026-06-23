# coder — design

## What it is

coder is a coding agent. Same category as Claude Code and Opencode: it talks to you,
reads and writes files in your repo, runs shell commands, and calls a model in a loop
until the task is done. If you've used those, you know the shape.

What's different is what it optimizes for, and where it puts that. Most agents spend
tokens freely and let the conversation fill up with tool schemas, raw command output,
and history. coder treats three things — **accuracy, token efficiency, and cost** — as
constraints built into its basic pieces, not features bolted on later. The bet: you can
keep an agent at least as capable while making it leaner, more accurate, and cheaper —
and the savings compound the more you use it.

## Why, honestly

Two reasons, in order:

1. **Accuracy.** Long context makes every current model *worse*, not just slower and
   pricier — measured across 18 frontier models [chroma], plus the classic "lost in the
   middle" result [lim]. So keeping context short and relevant is first an accuracy
   lever. This is the reason that stays true.
2. **Cost and speed.** Fewer tokens is cheaper and faster. This matters less over time —
   token prices keep falling and caching cuts input cost further — so it's the secondary
   benefit, and we don't pretend "tokens in context = cost" once caching is in play.

We lead with accuracy because it's durable.

## How the agent works

The agent only ever does three things:

- **Think** — call the model. Powerful, non-deterministic, expensive. Last resort.
- **Act** — run a primitive tool: read/write/edit a file, run a shell command, grep.
  The model decides when and how.
- **Compute** — run a deterministic operation: plain code that takes input and returns a
  clean, structured answer, with **no model call**.

One rule drives everything: **prefer Compute over Think.** Anything you can work out with
code — the state of a PR, whether tests passed, where a function is defined — shouldn't
cost a round of model reasoning and shouldn't dump raw output into the conversation.

## The one building block: a deterministic operation

Earlier drafts had two things, "Capabilities" and "Extractors." They were the same thing
seen from two angles, so now there's one. A deterministic operation is a small function:
**input → structured output, no model.** It has four independent properties.

**Where it's triggered** (an operation can be exposed in more than one place):

- a **slash command** you type (`/pr-status`) — no model tokens
- a **tool** the agent calls — costs the tool's schema plus the call, but no reasoning
  chain and no raw output in context
- an automatic **filter** on a noisy tool's output — e.g. turn a 500-line test log into
  "3 failed, here's which" before the model ever sees it (this was the "Extractor")
- a **shortcut** the dispatcher matches straight from your intent — no model tokens

*Honesty note:* only the slash-command and shortcut paths are truly zero model tokens.
The tool path is cheap, not free. We stopped calling all of them "zero-token."

**Where it runs:**

- **local** — fast, no network, runs anywhere (e.g. find a definition). These are the
  ones we promise are quick.
- **remote** — needs the network and usually a credential (e.g. PR status from GitHub).
  These run on your machine, never inside the sandbox, can fail, and return a typed
  "here's the answer or here's the error."

(That split fixes a real bug in earlier plans, which lumped `pr_status` — a network call
needing a token — in with the fast local operations.)

**What it does:** almost all of these just read. A few might write (a deterministic code
transform). **How much we trust it:** see below.

## Measuring everything, including accuracy

Every task produces a receipt: tokens in/out, cost, which model tier, whether a
deterministic operation answered it. We also record an **accuracy signal** — but only one
we can stand behind, and it differs by task:

- **Code changes:** did the tests pass? Did it typecheck? A real pass/fail, not the agent
  grading itself.
- **Deterministic operations:** occasionally run both the operation and the model on the
  same question and check they agree. Agreement builds confidence; disagreement means the
  operation is stale or broken, and we flag it.
- **Free-text answers** (explanations, lookups): usually there's no ground truth. We don't
  fake a number — we track signals that the model was unsure (for instance, it got
  unusually wordy) and surface them as "unverified."

The rule: **measure everything, and never report an accuracy number we can't back up.**

## How an operation earns trust

This matters most for operations the system writes itself (see Distiller). A *wrong*
deterministic operation is worse than re-deriving the answer, because it's silently
treated as fact. So trust is earned, not granted:

- **built-in** — hand-written by us. Trusted.
- **on probation** — freshly written by the system. It runs, but its answer is marked
  provisional and we shadow-check it (the agreement check above) on a fraction of calls.
- **trusted** — passed enough shadow checks. Now authoritative, re-checked occasionally,
  and automatically demoted if it starts disagreeing.

**People decide what operations exist** (you approve them — it's a commit). **Evidence
decides which ones are trusted.**

Two kinds of validation, kept separate:

- *The code is correct* — we keep recorded input→output examples and replay them. This
  works even for live things like PR status, because we freeze the recorded input and test
  the parsing, not today's live value.
- *The answer is right today* — that's the shadow check.

## The supporting machinery

Plain descriptions; none of this is exotic.

- **Dispatcher** — looks at your input and picks the cheapest way to answer: a
  deterministic operation, a slash command, or the model. Model turns start on the
  cheapest capable tier.
- **Context budget** — assembles each turn's context by relevance and trims it to a
  target. Keeps the right things in front of the model (accuracy) and the bill down. We
  lay context out so the stable part can be cached and only the variable part changes.
- **Receipts + notes** — two separate stores, on purpose. Receipts are append-only
  history (never edited). Notes are a scratchpad the agent rewrites as work progresses.
  Conflating them was a mistake.
- **Telemetry** — OpenTelemetry spans and metrics for every operation from day one;
  per-call token/cost via the AI SDK. Off until you point it at a backend. Privacy-first
  product analytics (Counted), opt-out, never your code or prompts.
- **Output control** — we keep the model's own answers short *structurally*: strip
  boilerplate before it's shown and before it re-enters history, prefer structured
  results, and measure verbosity. We don't rely on "be brief" in the prompt. Honest
  scope: this only touches prose and reasoning — code, diffs, and structured output are
  never shortened.
- **Distiller** (a bet, not a guarantee) — a background job that scans receipts for
  repeated, identical chains the agent keeps re-deriving, and proposes a deterministic
  operation to replace them. It only proposes when the math says it'll pay off, it checks
  the proposal isn't a duplicate of one we have, and anything it writes starts on
  probation. If this tail of repeated work turns out thin, coder is still a good agent
  without it — we don't bet the product on it.

## Sandbox and workspace (normal agent plumbing)

- One **git worktree** is the unit of work (1:1 with a branch). Chat and a real terminal
  are both pinned to it.
- The agent runs **sandboxed in a per-worktree container**; file edits and shell commands
  happen there. **Credentials never enter the sandbox** — only the host holds them, and
  only the host makes model and remote-operation calls.
- Tools are confined to the worktree (no `..`/symlink escapes).

## What it's not (v1)

- Not a hosted/multi-user service; no web UI.
- Not a general chatbot — it's for coding.
- Won't trust a self-written operation without shadow-checking and your approval.
- Won't shorten code, diffs, or structured output to save tokens.
- Won't report an accuracy number it can't back up.

## Self-contained

Its own repo and `coder` binary, multi-provider through the Vercel AI SDK, zero runtime
dependency on glrs. glrs is reference only — small patterns (worktrees, cost tracking,
tool-output truncation, background jobs) reimplemented clean, never imported.

## Build order

Each phase runs on its own.

- **P1** — the agent loop + primitive tools + a handful of hand-written local operations
  + output filters + receipts + telemetry + relevant-context assembly as a simple flat
  list (no gating yet). Headless (`coder --once`); tested against a mock model.
- **P2 (MVP)** — the terminal UI: chat, slash palette, inline approvals, a status bar
  (tokens/cost/context), beside a real shell pane.
- **P3 (the bets)** — the Distiller and the trust/shadow machinery; remote operations;
  relevance-gating of a now-larger operation set; the notes scratchpad.

We deliberately *don't* build relevance-gating, the Distiller, or remote/self-written
operations until P3 — with a handful of built-in operations, a plain list is simpler and
strictly better.

## Layout

```
coder/
  bin/coder
  packages/coder-core/     # protocol/types, worktree+git glue, event-log, loaders
  packages/coder-server/   # dispatcher, AI SDK loop, tools, deterministic operations,
                           #   output control, context budget, receipts+notes,
                           #   telemetry (OTel+Counted), Distiller, registry, SSE
  packages/coder-tui/      # terminal UI: chat + / palette + approvals + status bar
  .coder/                  # (in target repos) operations/ proposals/ fixtures/ registry.json
```

## References

- [chroma] Chroma — *Context Rot: How Increasing Input Tokens Impacts LLM Performance*.
  https://www.trychroma.com/research/context-rot
- [lim] Liu et al. — *Lost in the Middle: How Language Models Use Long Contexts*. arXiv:2307.03172.
- [ctx-eng] Anthropic — *Effective context engineering for AI agents*.
  https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- [verb] *Demystify Verbosity Compensation Behavior of Large Language Models*. ACL 2025.
  https://aclanthology.org/2025.uncertainlp-main.14/
