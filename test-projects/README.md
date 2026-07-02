# test-projects — agentj's eval harness

A small, fixed set of real projects + tasks to run agentj against, so we can check behavior
consistently instead of spinning up one-off worktrees. Each project is original and deliberately
small, but shaped to exercise the things agentj gets wrong in the wild.

## Run it

```bash
bun test-projects/run.ts               # all tasks (live agent runs — needs provider creds, below)
bun test-projects/run.ts dist          # only tasks whose id contains "dist"
bun test-projects/run.ts --selftest    # NO agent, no creds: prove every Full task's graders FAIL on
                                       # the unsolved fixture and PASS on its reference `solution`
KEEP=1 bun test-projects/run.ts ts     # keep the throwaway dir to inspect the diff
bun test-projects/run.ts --prompt detailed   # pick a prompt variant (default: first listed = terse)
bun test-projects/run.ts --all-prompts       # run every variant of every task (id@variant rows)
```

Live runs need provider creds in the env — with the wired Azure/OpenAI-compatible path:

```bash
AGENTJ_PROVIDER=azure AGENTJ_MODEL=gpt-5.4 AZURE_BASE_URL=… AZURE_API_KEY=… \
  bun test-projects/run.ts dist
```

Every run appends one JSON line per task to `results/history.jsonl` and captures the agent's full
output under `results/out/` (both gitignored) — the evidence trail behind any pass-rate claim. Tasks
may declare a `timeoutSec` (default 600); a hung agent is killed and graded as a FAIL. For each task the runner copies the project to a temp dir, writes a
`.gitignore` (keeps installed deps out of git), `git init`s + commits it (call that commit `base`),
installs deps, then runs `agentj --once` **in that dir** (no worktree — the copy is the sandbox). The
originals are never mutated.

A task **PASSes** iff every grader it declares passes:
- `verify` — a command exits 0 (e.g. the suite goes green).
- `expect` — every listed substring appears in agentj's output.
- `expectNoChange` — no source files changed vs `base` (read-only / diagnosis tasks).
- `judge` — an LLM grades agentj's diff + report against a rubric (open-ended design tasks).
  **Temporarily disabled** — it depended on the removed TS judge; `judge` tasks grade on `verify`
  alone until a Rust judge lands.

Diff-based graders compare against `base`, so a agentj that commits its work is graded the same as one
that leaves it uncommitted.

## Projects

| dir | toolchain | shape it tests |
|---|---|---|
| `pnpm-vitest-monorepo/` | pnpm workspace · vitest · turbo-wrapper root | workspace detection (vs a stale `package.json` `workspaces` field that shadows `pnpm-workspace.yaml`), scoping a wrapper root to the package that owns a failing test, single-test iteration, fixing **source** not the test |
| `python-pytest/` | python · pytest | python/pytest detection, single-test iteration (`pytest -k`), real source fix |
| `go-stdlib/` | go · std testing | go detection, package-scoped iteration, real source fix |
| `frontend-cart/` | vanilla JS · Playwright + system Chrome | **frontend** work the model can't see: a storefront whose discount logic has a runtime bug, verified through a real browser (Playwright `channel:chrome`). Tests whether the agent fixes UI logic AND verifies it in a browser (via agentj's `web_check` tool or the e2e suite) rather than eyeballing code. Needs bun + Chrome. |
| `cloud-incident/` | pure Bun · four HTTP services + mock cloud CLI | **operational** debugging: observability lives behind `ops/cloudctl` (gzipped sharded logs, deploy/config history, metrics) with strict flags and pagination. Three overlapping incidents (a config-regression cascade, a needle-in-haystack OOM orphan, a stale ops flag with an innocent code suspect), a TOCTOU race across an await boundary, a do-not-modify vendor fault, and token-budget graders. |
| `bun-microservices/` | pure Bun · three HTTP services | **distributed** work: a gateway → orders → inventory system with real HTTP between services, per-service `/__logs` debug endpoints, and a captured incident-log corpus (`ops/`). Tasks: cross-service log-correlation investigation (INC-231), a bug that only shows by tracing an id hand-off across two service boundaries, an end-to-end request-tracing feature, and a retry-safe idempotency feature — each Full task carries a reference `solution` proven by `--selftest`. |

Each Full task has a **planted bug or seeded spec** that fails deterministically. The win condition
is agentj finding the root cause / implementing the contract so the whole suite passes — without
editing the tests to match.

## Add a project

1. Drop a self-contained project under `test-projects/<name>/` (real lockfile-free source; the runner
   installs). Keep it tiny.
2. Add a task to `tasks.jsonc`: `{ id, project, prompt, setup, verify }` — `setup` installs deps,
   `verify` is the command that must exit 0 once the task is done.
3. Ship a reference `solution` (a shell command applying files from `_seeds/solutions/…`) and run
   `bun test-projects/run.ts --selftest <id>` — it proves `verify` FAILs on the unsolved fixture and
   PASSes on the solution. A task without that proof can silently test nothing.

Keep `verify` strict and objective (a passing suite, a specific assertion) — the harness is only as
honest as its checks.
