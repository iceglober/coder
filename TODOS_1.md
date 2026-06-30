# coder — TODOS · Done

Shipped, grouped by capability (aligned with [docs/PLAN_1.md](./docs/PLAN_1.md)). Remaining work
is in [TODOS_2.md](./TODOS_2.md). ✅ = complete.

---

## Agent core

- ✅ **Non-streaming loop**: `ToolLoopAgent.generate()` rendered per-step; the Vertex streaming path mangled Gemini-3 thought-signatures on tool replay.
- ✅ **Guaranteed conclusion**: hitting the step ceiling (40, `CODER_MAX_STEPS`) forces a final no-tools synthesis — always an answer.
- ✅ **Subagent orchestration**: triage (investigate/direct) → isolated read-only investigator → implementer; keeps only the verdict + report, never transcripts. **Direct is a subagent too** — it runs isolated and only its compact result threads to history (the tool transcript never persists); every path returns `prior compact history + this turn's compact pair` (fixed a gap where direct kept the full transcript and investigate dropped prior turns). One terminal `turn.idle` per user turn; `phase.start/end` bracket each phase for the TUI. A clarifying-question investigation **stops at the diagnosis** (no implementer over a question — `endsByAsking`); the question is surfaced as the answer.
- ✅ **Subagent continuity**: subagents get the compact prior-turn verdicts (working memory); triage reads recent session so follow-ups route direct.
- ✅ **Cut-off = resumable working memory**: a step-limit conclusion writes a progress note (changed/established/tried/hypothesis/next); `cutOff` makes the orchestrator continue, not blind-apply.
- ✅ **Role-as-toolset keystone**: tools declare `effect` (read|verify|write); a role is a filtered view (`toolsForRole`); investigator = read+verify; policy effect-aware (verify allowed in plan).
- ✅ **Permission policy**: per-call `decide → allow/ask/deny`, posture presets + per-tool overrides, effect-aware; interactive `--mode ask` in-process.
- ✅ **Models**: multi-provider (Vertex/Gemini + Anthropic), per-provider tiers, preflight; `/models` + `/model <id>` live-switch persisted; dynamic models.dev pricing (cached, >200k tier) + prompt-cache-aware (`% cached`); on AI SDK v7.
- ✅ **SIGINT cancellation**: Ctrl-C → AbortSignal through the tui + runner.
- ✅ **Single loop**: deleted the unwired `loop.ts`; `runner.ts` is the one path, mock-model injectable.

## Behavior steers (workflow → prompt/triage; evidence, not exhortation)

- ✅ **Ambiguity**: a vague task routes to *direct*; charter + investigator state a bounded interpretation + smallest change, or ask — no guess-and-sweep.
- ✅ **Structured clarification**: coder NEVER asks in prose — it calls the `ask_user` tool with multiple-choice questions (2–4 options each, a recommended default), emitted as a `questions.required` event; the orchestrator stops (no implementer over a question) and it's never sign-off-worthy. The TUI renders them in a full-screen **modal** with an ASCII alien-scholar hero whose **eyes blink** every ~3s (↑/↓ · a–d · Enter · Esc), and the picks submit as the next turn.
- ✅ **Delegation reasoning**: for an ambiguous task / missing input, coder leads with its understanding (what it grasped + searched + couldn't find), then asks the **delegation fork** — (a) have-it-share-next · (b) show-me-options · (c) **you-decide (default)** — biasing to autonomy. For (c) it decides from context or asks ONE narrow follow-up, then commits; never chains rounds. (charter + investigator prompts.)
- ✅ **Choice Display abstraction**: options carry a typed `preview` — `swatches` (hex → colored blocks), `code`/pseudocode, `tree` (file layout), `chart` (scaled ASCII bars), `text`. Protocol (`ChoicePreview`) + `ask_user` schema + a TUI `ChoicePreviewView` (truecolor swatches via chalk hex; blocks truncated). So "show me options" shows the actual colors, not just labels.
- ✅ **Failing-checks (PR-aware, ordered)**: for "fix failing checks on PR X" the investigator does a fixed ORDER — (a) fetch the PR's CI status via the declared command *described* as that, (b) pull the failing job's LOGS for the exact failing tests, (c) only THEN reproduce (run the declared test-env-setup command first), (d) fix only what's named, verify by re-running that one test. No reading code / local tests before (a)–(b) — the bug that made it spelunk 30 calls without ever fetching CI. Validated against a real kn-eng PR-checks task in a throwaway worktree.
- ✅ **Whole-workspace**: `script`'s result *notes* when a bare `test` ran every package — evidence on the tool, not the charter.
- ✅ **Timeout guard + wall-clock**: `RunSignals` counts timeouts per task; the tool refuses a 3rd spawn after 2 timeouts (returns evidence). `Effort` gained `timeouts` + `toolMs`, both on the receipt line.
- ✅ **Thrash signal**: exact-repeat calls counted into `effort.repeatedCalls` and surfaced; measured, not nudged.
- ✅ **Legible failures**: `test_summary` keeps the failure block (assertion + `file:line`), not just counts.
- ✅ **Verification matches the goal** (charter): a CSS overflow bug got "fixed" 3× with `[checked] ran typecheck` as evidence — a gate orthogonal to the visual goal, presented as success. Fix: verify against WHAT THE TASK ASKED, not a convenient gate; a green check that doesn't exercise the goal is NOT evidence; for things coder can't observe (visual/CSS/UI render/runtime UX) it must say "unverified — couldn't see the result", tag it a guess, and ask to confirm rather than manufacture certainty. Evidence must support the *specific* claim. ⬜ stretch: give coder sight (headless render/screenshot) so UI tasks self-verify.

## Project intelligence

- ✅ **Polyglot toolchain detection**: `detectProjectFacts` (js/python, pluggable `Detector`); deterministic, cached, gitignore-respecting; persisted `{computed, overrides}`, overrides win + survive.
- ✅ **script tool**: resolves + runs the exact command per path — npm-vs-pnpm error class gone; facts slice is a one-line pointer (commands live in the tool).
- ✅ **Workspace-scoped commands**: a path inside a package scopes to it (`pnpm --filter …`); install stays repo-wide.
- ✅ **Single-file + single-TEST variant**: a test FILE runs just that file via the package's cached runner (bypassing a turbo/wrapper root); and `script("test", "<file>", {testName})` runs just ONE test by name via the runner's filter (`vitest -t` / `pytest -k`) — seconds, not the whole 120s file. The iteration-killer fix from the kn-eng run; lives in the computed toolchain layer (the detector knows the runner's flag), driven by the "tightest feedback loop" principle.
- ✅ **Workspace-precedence bug (found via the kn-eng validation run)**: `pnpm-workspace.yaml` now wins over a stale npm-style `package.json` `workspaces` field. kn-eng's root had `workspaces:["packages/hand"]`, which shadowed the yaml → the detector saw 1 of 37 packages → `apps/web-app` never matched → every test scoped to the root `turbo test` (whole suite, 120s/exit-137). pnpm ignores the package.json field entirely; the yaml is authoritative. Regression-tested.
- ✅ **Go detector** (validates "a language is one detector"): `goDetector` — one toolchain per `go.mod`, `go test`/`build ./...`/`vet`, `runner:"go"` unconditionally. Single test is **package-scoped** (`go test ./pkg`, not the file) with a name filter via `-run` and an **anchored regex** (`go test -run '^TestName$' ./pkg`). No other wiring (resolve/render pick it up). Regression-tested.

## Eval harness + worktree isolation

- ✅ **Worktree mode** (reversed a recorded "Cut" decision — PLAN_2.md updated with the why): self-contained `createWorktree`/`removeWorktree`/`assertPrimaryClone` in `coder-core/worktree.ts` (plain `git worktree`, **no glrs dep**), worktrees under `~/.coder/worktrees/<repo>/<branch>`. `coder --worktree` runs on a throwaway branch (kept for review). The nested-clone guard refuses to branch a worktree off a worktree.
- ✅ **`test-projects/` eval harness**: committed fixtures (pnpm-vitest monorepo · python-pytest · go-stdlib) + `tasks.jsonc` + `run.ts`. Each task runs coder in an **isolated worktree** of a throwaway copy → graded by `verify` (exit-0), `expect` (facts in the answer), or `expectNoChange` (read-only); `needs` skips a task when a tool (e.g. `go`) is absent. A `seed` perturbs the clean baseline pre-commit so multiple task types share one project.
- ✅ **Full JS 5-type set** (the pnpm-vitest monorepo carries all five on a consolidated `packages/core` domain; `apps/web` is a trivial member): `js-question` (read-only, facts), `js-investigation` (mocked log + seeded sqlite + declared `app-logs`/`db-query`, diagnose-only), `js-full-simple` (seeded bug fix), `js-full-moderate` (stacking discount engine — order/floor/clamp/rounding edge cases), `js-full-advanced` (multi-currency: `Money` value type + cross-module cart migration + currency guards, behavior-preserving). All PASS. **Difficulty calibrated** to "Moderate = mid-level barely / Advanced = staff+": Advanced went 26s→138s (5×) + 2 files. NOTE: test-spec grading makes tasks *guided-hard* (much to build, but the spec says what) rather than *ambiguous-hard* (figure out the design) — true staff-level ambiguity would need an LLM judge, not a test.
- ✅ **Python 5-type set** (replicated from JS): a `store` domain (money/cart/order/config) carries all five — `py-question`, `py-investigation` (mocked log + sqlite + declared commands, diagnose-only), `py-full-simple/moderate/advanced` (bug · discount engine · multi-currency `Money`). **5/5 PASS**, same difficulty profile as JS (Advanced 107s/2-files cross-module). `_seeds/` excluded from pytest collection (it runs from the repo root, unlike per-package vitest).
- ✅ **Go 5-type set** (replicated; `go` installed to author it validated): a `store` package mirrors the domain — `go-question`, `go-investigation` (diagnose-only), `go-full-simple/moderate/advanced` (bug · discount engine · multi-currency `Money` with Go error-return currency guards). **5/5 PASS** (Advanced 109s/2-files). `_seeds/` auto-ignored (Go skips `_`-prefixed dirs).
- ✅ **Full eval grid complete: 15/15 tasks pass — 5 types × 3 toolchains** (pnpm-vitest · pytest · go). Same difficulty profile across all three (Advanced ~110–140s, cross-module). The harness caught + drove the fix for one real coder gap (finding #1) along the way.
- ✅ **Eval finding #1 (caught by the harness, then fixed)**: coder over-stepped a diagnosis-only request — on an explicit "don't modify, just report" it diagnosed correctly but edited `order.ts` anyway. **Fix:** a third triage mode `diagnose` — the model classifies a report/explain/audit/"don't change" intent and the orchestrator stops at the investigator's verdict (no implementer), mirroring `endsByAsking`. `js-investigation` now passes read-only, and 4× cheaper/faster (no wasted implementer pass); "fix" tasks still route investigate→implement. `runner.ts` triage + orchestrate.
- ✅ **Declared + parameterized commands**: stack-neutral remote CI as a declared `commands` entry; named placeholders (`{pr}`) filled from a model `args` map, **shell-quoted** (injection-safe), `task` validated.
- ✅ **Self-describing commands (select by intent)**: a declared command can be `{cmd, desc}`; `renderFacts` advertises `name(args) — desc` and the model **selects by intent** (matches its need to the description). No canonical roles, no command name in the prompt — universal toolchain tasks (test/build/lint) stay computed; everything bespoke (CI checks, test-DB setup, deploy) is declared + described + model-selected. `declare_command` captures the `desc`. Fixed the brittle steer that hardcoded `script("checks")` (repo named it `get-pr-checks`).
- ✅ **Unified capability model** (research-grounded): one concept — a few always-on **native tools** (the hot path) + a **dispatcher (`script`) over a compact described catalog** for the long tail. Operations / toolchain tasks / declared commands / (later) MCP are all catalog entries differing only by implementation — ~24 tok/entry vs 60+ as a native tool vs 550–1,400 for a raw MCP tool. The dispatcher+catalog is the token-efficient core (confirmed vs Anthropic/Cursor/MCP numbers); "each capability a tool" is the token-fatal path. Docs rewritten around it (Capabilities · Filters · Project-knowledge = config/runbook/memory); Think/Act/Compute demoted to the thesis.
- ✅ **Dispatcher detail-step**: `script` replies with the exact usage when passed arg names that don't match a command's placeholders (`'pr-checks' takes {pr_number} — you passed {pr}`) instead of silently dropping the arg and misfiring — closes the two-stage-dispatch accuracy gap (the `{pr}` vs `{pr_number}` bug class).
- ✅ **Code-execution dispatch (`run_code`)**: the research's #1 token win — keep intermediate RESULTS out of context. The model writes a small program; only what it `console.log`s returns (a 1MB read → one line; a 300-line CI log → the 3 failing test names). Predefined value-returning helpers: `run(name,args)` (project commands BY INTENT — declared + test/build/lint), `sh(cmd)`, `read(path)`, baked into a portable `node:`-API preamble. **Runtime is project-detected** (bun project → `bun`, else `node`), which also means it runs in the matching sandbox image. Reuses the bash path (gate, 120s kill, host-vs-sandbox routing); the credential law holds (runs where bash runs, never gets host creds in a sandbox). Effect `write`, gated like bash, denied in plan. `__q` mirrors `shellQuote` (parity-tested). Temp `.coder/run/<uuid>.mjs` deleted after. ⬜ fast-follow: save a proven snippet as a named op (`.coder/ops/` + declare_command) → the Distiller.
- ✅ **Onboard like a new dev**: when coder can't tell how to run a task (the classic: tests need a DB stood up), it asks the questions a new hire would and persists the answer with a `declare_command` tool → a `commands` entry in `.coder/facts.json` that `script(task)` runs as a **zero-token op** forever. Auto-allowed except plan; visible (`📋 declared command: test = …`). Charter steers it to propose a facts.json amendment only when it hits the gap. **Timed proposals**: `ask_user` questions take a `timeoutSec` — the modal shows a countdown and auto-selects the default if the user is away (any keypress cancels), so coder isn't blocked.
- ✅ **Project pattern memory**: coder elicits + records durable patterns (design/architecture/tooling/infra/convention) via a `remember` tool into a `patterns` section of `.coder/facts.json` (sibling of `overrides` — never auto-regenerated). A pattern holds a literal `value` OR a **`ref` to live code** (preferred — stays current when code changes, read on demand, keeps the codebase DRY). `renderPatterns` injects a compact pointer index each turn (contents never inlined). Auto-saved but **visible** (`🧠 remembered` line), auto-allowed except **denied in plan mode**. ⬜ relevance-gate the index at scale.

## Execution safety

- ✅ **Sandbox (P0)**: `CommandRunner` seam; `DockerSandbox` (bind-mount, lifecycle, in-container timeout, hardening, mount preflight); **creds never enter the sandbox**.
- ✅ **Routing by source**: untrusted repo code → sandbox, trusted declared commands (`gh`) → host, so isolation doesn't break the forge workflow.
- ✅ **OOM guard**: `script`/`bash` share a concurrency gate (default 1, `CODER_MAX_PARALLEL_COMMANDS`); reads stay parallel; the gate sits in the execute wrapper so the UI shows real serial execution.
- ✅ **Process-group kill**: commands spawn detached; abort/timeout kills the whole tree (bash→turbo→vitest→workers) — Ctrl-C is instant. Path confinement rejects `..`/symlink.
- ✅ **Change accountability**: the runner always appends a computed `📝 changed N files: …` footer (from the edit tools); carried into `changedFiles` + the report; charter requires listing changes.

## Measurement

- ✅ **Ledger + receipts**: append-only JSONL; `effort` (computed) + `checks` (gate) + `verdict` (borrowed); `event-log` backing.
- ✅ **Sign-off**: `/y`·`/n`·`/skip` capture the verdict to `verdicts.jsonl`, folded latest-wins; Ctrl-C on an unsigned result → `abandoned`. Gated on `signoffWorthy` — only a real resolution (changed files, or real work that didn't end in a clarifying question) prompts; a greeting / "what kind?" doesn't.
- ✅ **Charter verdict standard**: lead-with-answer, evidence as `file:line`, tag checked/reasoned/guess, list changes.
- ✅ **Sign-offs pay off**: a rejection used to only feed a stats counter — now it steers the NEXT turn. `Ledger.rejectionStreak()` (consecutive most-recent rejections); the runner injects a turn-start steer — streak 1 = "don't repeat that approach, find a different one"; streak ≥2 = "STOP, change strategy (reproduce differently / ask / re-find the root cause), don't ship another variation". Directly attacks the CSS-by-guesswork loop. ⬜ behavioral backfill (infer accept/reject from the next turn so most are free); file-scoped thrash; anti-pattern memory.
- ✅ **/stats**: verdict mix + accepted-rate + avg effort + time-in-tools + timeouts.

## Context

- ✅ **History compaction**: summarizes older turns past 16k tokens, keeps recent verbatim, safe-degrades.

## Deterministic operations & dispatch

- ✅ **OperationRegistry**: tool/filter plumbing (`operationToolSet`, `RunSignals`).
- ✅ **Built-ins**: `git_state` + `find_def` (tools) + `test_summary` (filter), wired into the loop.
- ✅ **Zero-token dispatch**: explicit slash commands (`/git-state`, `/read`), no model/creds/sandbox, confidence-gated; free-text NL guessing removed.

## Interface

- ✅ **In-process default**: `coder` chats in-process; `--once`/`--serve`/`--connect`.
- ✅ **Full-screen Ink TUI with tabs**: captive alt-screen; tabs = concurrent sessions (async turns); **per-tab live CPU/RSS** from each session's process group; word-wrap + scroll (Ctrl-U/D); single-key `y`/`n` sign-off; per-session `/sandbox`; input history. `--classic` keeps the line client.
- ✅ **Per-session resource plumbing**: `onStart(pgid)` → `onCommand` → `sampleByPgid` (one `ps`, by group). Sampled every 250ms with a ~1.25s **peak-hold** so short commands' load actually shows — at 1s with instant zero-on-finish, a sub-second command's reading never appeared on screen.
- ✅ **Transcript tree**: the engine emits `phase.start`/`phase.end` around each phase; the TUI renders a subagent run as a GROUP whose tools stream live, then **collapse — hiding the tool noise but ALWAYS keeping the verdict/question visible** (a clarifying question can't be buried). Arrow keys navigate nodes; Enter expands/collapses a group; verdicts get inline `**bold**` styling. Renders ≤ rows-1 lines (headroom — filling the full height scrolls the terminal and corrupts Ink's redraw); `wrapLine` splits on `\n` first so every transcript row is exactly one physical line (markdown messages were breaking the height accounting → garbled overlap).
- ✅ **Readable transcript (markdown + gutters)**: verdicts render formatted markdown — headings (bold, `#` stripped), `•` bullets, inline `**bold**` + `` `code` ``, fenced blocks (dim) — classified per LOGICAL line before wrapping so wrapped continuations keep their role. Each node gets a 1-char color-coded **gutter** (cyan=you · green=coder · magenta=subagent · dim=tools) as a cheap container; blank spacer rows separate turns; nav selection brightens the gutter (not full-row inverse). All inside the line-safe pipeline (`flatten`/`emitMarkdown`/`RowText`), unit-tested. ⬜ span-aware wrapping (a bold/code span that wraps mid-span shows literal markers); bordered cards need the Path-B scroll refactor.
- ✅ **Context meter**: status line shows `ctx prime Nk · sub Nk` — `prime` = estimated tokens of the persistent main-agent context (the budget that compounds), `sub` = cumulative ephemeral subagent tokens this session (the cost of isolation, which never persists). Engine returns `usage:{prime,subagent}` per turn (prime = est. of the compact history; subagent = summed sub-run `totalTokens`). ⬜ swap the ~4-char/token estimate for a real per-slice `ContextComposition`.
- ✅ **Live progress / heartbeat**: one bottom line showing the running call with args + clock, or `thinking`; cursor hidden while animating. In the Ink TUI, a running tool shows the moment it starts (`⠹ script(test) · 12s`, live elapsed) via a per-session `live` set, then becomes the finished transcript row on `tool.end`. (Per-tab CPU/mem removed from the tab bar; kept on the status line.)
- ✅ **Server / SSE**: protocol types; runner event stream; `server.ts` routes (session/SSE/message/interrupt, bearer auth); permission round-trip.
- ✅ **Raw-mode input + conversation memory**: stdin owned (no echo), TTY-guarded; history threaded across turns.

## Output control

- ✅ **OUTPUT_CONTRACT** wired into the system prompt; `verbosityRatio` + spike threshold defined.

## Docs

- ✅ **coder-docs**: dependency-free Bun-served concept site; **Build status** reads the TODOS live.

## Cross-cutting

- ✅ **Converged tool paths**: deleted `loop.ts` + dead `Tool`/`CORE_TOOLS`; `agent/tools.ts` is the single definition.
