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

## Design heuristics — where capabilities go

When you add a capability, these decide where it lives. They're the rules we keep re-deriving;
follow them so the codebase stays coherent.

1. **Steering: tool-usage → the tool; workflow → the role prompt.** Guidance on *how to call one
   capability well* ("a bare `script('test')` runs every package — pass a path to scope") lives
   **with that tool** (its description + its result), because that's where the decision is made and
   it travels with the capability. Guidance on *how to approach a task class* ("for a failing-checks
   task, find which checks fail first") lives in the **role prompt** (`agent/prompt.ts`). Per-tool
   minutiae never goes in the global charter — wrong layer, and it bloats every prompt.
2. **Structure over hope — and when the model must judge, give it evidence, not exhortation.** The
   model ignores upfront prompt text under load. Prefer a deterministic mechanism; failing that, have
   the **tool report what it did** (e.g. "ran 23 packages") so the lesson lands from the result.
   Banned as hacks: mid-loop prompt-injection nudges, keyword routers, command-string classification,
   appending guessed args/flags to commands.
3. **Model capabilities, not vendors.** Never bake in GitHub / pnpm / vitest / a CI provider. Detect
   the provider from the repo (a pluggable detector registry), keep a stack-agnostic core, degrade
   gracefully when it's absent. Toolchains, forges, and CI all follow this shape.
4. **Configuration over enumeration.** For the irreducibly stack-specific (a remote-CI command, a
   bespoke build), let the repo **declare** it (`.coder/facts.json`) — don't maintain a vendor-adapter
   zoo. Computed where detectable, declared/overridden where not; overrides win and are validated.
   Example: tests that need infra are a *setup-aware declared command*, not new machinery —
   `"commands": { "test:ci": "pnpm stack:up && pnpm test" }` — rather than coder modelling task
   prerequisites. (If a check chronically times out, the `script` guard refuses it and says so; the
   answer is a declared setup-aware command, not a longer timeout.)
5. **Roles are toolsets; capabilities declare effects.** A tool/operation carries `effect:
   read | verify | write`. A subagent role is a **filtered view of the registry by effect**
   (`toolsForRole`), not a permission posture. Read-only means *no edits*, not *no execution* — an
   investigator runs checks (verify) to reproduce a failure.
6. **Measure the symptom, fix the cause.** A bad pattern (e.g. thrash) becomes a *measured signal* on
   the receipt plus a *better tool* — never a mid-loop intervention.
7. **Every addition is a net win on context.** A prompt slice, a receipt field, working memory — each
   justifies itself on the token budget, or the data moves to a cheaper layer (in the tool, not the
   prompt).

## Repo conventions

- Bun workspace; TypeScript strict (`tsconfig.base.json`). ESM only.
- `bun run typecheck` / `bun run test` / `bun run lint` at the root fan out to all packages.
- Package dependency direction: `coder-core` ← `coder-server`, `coder-tui`.
  `coder-core` depends on nothing in-repo.
