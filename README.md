# coder

A coding agent — same category as Claude Code and Opencode — that **prefers computing
over thinking** and keeps its context short on purpose, because long context makes models
less accurate as well as more expensive.

> Status: **scaffold.** Workspace skeleton — package boundaries, shared types, and module
> stubs that mirror [`docs/PLAN.md`](docs/PLAN.md). See [Phases](#phases) for what's real
> vs. stubbed.

## The idea

The agent only ever does three things: **Think** (call the model — last resort), **Act**
(read/write files, run commands), or **Compute** (run a deterministic operation: plain
code, input → structured answer, no model call). The rule is *prefer Compute over Think* —
anything you can work out with code shouldn't cost a round of reasoning or dump raw output
into the conversation. We measure everything, including accuracy, and never report an
accuracy number we can't back up.

Read the full design in **[`docs/PLAN.md`](docs/PLAN.md)**.

## Layout

```
coder/
  bin/coder                # binary entry — launches the terminal UI
  packages/coder-core/     # protocol/types, worktree+git glue, event-log, notes, loaders
  packages/coder-server/   # dispatcher, AI SDK loop, tools, deterministic operations,
                           #   output control, context budget, receipts+notes,
                           #   telemetry (OTel+Counted), Distiller, registry, SSE
  packages/coder-tui/      # terminal UI: chat + / palette + approvals + status bar
```

In **target repos**, coder reads & writes a `.coder/` directory: `operations/`,
`proposals/`, `fixtures/`, and `registry.json`.

## Develop

```sh
bun install
bun run typecheck
bun run test
bun bin/coder --help
```

## Phases

Each phase is independently runnable (see `docs/PLAN.md` § "Build order").

- **P1** agent loop + primitive tools + a few hand-written local operations + output
  filters + receipts + telemetry + flat relevant-context assembly, headless (`coder --once`).
- **P2** terminal UI: chat + `/` palette + approvals + status bar, beside a real shell
  pane. ← **MVP**
- **P3** the bets: Distiller + trust/shadow machinery; remote operations; relevance-gating
  of a larger operation set; the notes scratchpad.

## License

MIT — see [LICENSE](LICENSE). Self-contained; zero runtime glrs dependency.
