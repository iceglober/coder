# test-projects — coder's eval harness

A small, fixed set of real projects + tasks to run coder against, so we can check behavior
consistently instead of spinning up one-off worktrees. Each project is original and deliberately
small, but shaped to exercise the things coder gets wrong in the wild.

## Run it

```bash
bun test-projects/run.ts            # all tasks
bun test-projects/run.ts py         # only tasks whose id contains "py"
KEEP=1 bun test-projects/run.ts ts  # keep the throwaway dir to inspect the diff
```

Needs `GOOGLE_VERTEX_PROJECT` / `GOOGLE_VERTEX_LOCATION` in the env (the runner defaults them to the
Gemini-on-Vertex setup). For each task the runner copies the project to a temp dir, `git init`s it,
installs deps, runs coder once with the prompt, then runs the task's `verify` command — **PASS = it
exits 0**. The originals are never mutated.

## Projects

| dir | toolchain | shape it tests |
|---|---|---|
| `pnpm-vitest-monorepo/` | pnpm workspace · vitest · turbo-wrapper root | workspace detection (vs a stale `package.json` `workspaces` field that shadows `pnpm-workspace.yaml`), scoping a wrapper root to the package that owns a failing test, single-test iteration, fixing **source** not the test |
| `python-pytest/` | python · pytest | python/pytest detection, single-test iteration (`pytest -k`), real source fix |

Each has a **planted bug** that fails exactly one test. The win condition is coder finding the root
cause and fixing the source so the whole suite passes — without editing the test to match the bug.

## Add a project

1. Drop a self-contained project under `test-projects/<name>/` (real lockfile-free source; the runner
   installs). Keep it tiny.
2. Add a task to `tasks.jsonc`: `{ id, project, prompt, setup, verify }` — `setup` installs deps,
   `verify` is the command that must exit 0 once the task is done.

Keep `verify` strict and objective (a passing suite, a specific assertion) — the harness is only as
honest as its checks.
