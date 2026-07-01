# test-projects — agentj's eval harness

A small, fixed set of real projects + tasks to run agentj against, so we can check behavior
consistently instead of spinning up one-off worktrees. Each project is original and deliberately
small, but shaped to exercise the things agentj gets wrong in the wild.

## Run it

```bash
bun test-projects/run.ts            # all tasks
bun test-projects/run.ts py         # only tasks whose id contains "py"
KEEP=1 bun test-projects/run.ts ts  # keep the throwaway dir to inspect the diff
```

Needs `GOOGLE_VERTEX_PROJECT` / `GOOGLE_VERTEX_LOCATION` in the env (the runner defaults them to the
Gemini-on-Vertex setup). For each task the runner copies the project to a temp dir, writes a
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

Each has a **planted bug** that fails exactly one test. The win condition is agentj finding the root
cause and fixing the source so the whole suite passes — without editing the test to match the bug.

## Add a project

1. Drop a self-contained project under `test-projects/<name>/` (real lockfile-free source; the runner
   installs). Keep it tiny.
2. Add a task to `tasks.jsonc`: `{ id, project, prompt, setup, verify }` — `setup` installs deps,
   `verify` is the command that must exit 0 once the task is done.

Keep `verify` strict and objective (a passing suite, a specific assertion) — the harness is only as
honest as its checks.
