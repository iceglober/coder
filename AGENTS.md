# AGENTS.md — coder

Guidance for agents (and humans) working in this repo.

## What this is

`coder` is a self-contained coding agent — same category as Claude Code / Opencode,
evolved to bake accuracy, token efficiency, and cost into its primitives. Honor these
(full reasoning in `docs/PLAN.md`):

1. **Prefer Compute over Think.** Any fact you can work out with code becomes one
   deterministic operation (input → structured output, no model call), never a
   tool-and-reason chain that drags raw output into context.
2. **Keep context short — for accuracy first.** Long context measurably degrades every
   current model, not just cost; load tools/operations/docs/history by relevance and trim
   to a target.
3. **A wrong operation is worse than re-deriving.** Trust is earned: built-in operations
   are trusted; machine-written ones run on probation and earn trust via shadow checks.
   People decide what exists; evidence decides what's trusted.
4. **Measure everything, including accuracy — but never a number you can't back up.**
   Real pass/fail where tests exist; a shadow agreement check for operations; an honest
   "unverified" for free-text. Every task emits OTel spans + a receipt from day one.
5. **Keep output short structurally**, never by "be brief" prompting alone — and never
   shorten code, diffs, or structured payloads.

## Constraints

- **Self-contained.** Zero runtime dependency on `glrs`. glrs is prior art only —
  reimplement small patterns clean, never import.
- **Multi-provider via the Vercel AI SDK** (`ai` + provider packages). coder owns its
  agent loop on `streamText` + the tool-exec cycle; it does not delegate the loop.
- **Sandbox safety:** tools confined to the worktree (reject `..`/symlink); `bash` runs
  in the container; credentials never enter the sandbox.

## Repo conventions

- Bun workspace; TypeScript strict (`tsconfig.base.json`). ESM only.
- `bun run typecheck` / `bun run test` / `bun run lint` at the root fan out to all packages.
- Package dependency direction: `coder-core` ← `coder-server`, `coder-tui`.
  `coder-core` depends on nothing in-repo.
