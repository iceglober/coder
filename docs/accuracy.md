# Measuring quality

## The whole design, in one paragraph

coder does not grade its own correctness. For every task — coding, debugging, a question,
anything — it measures the same two things: **effort** (turns, tool calls, cost to reach an
endpoint — computed, always available) and a **verdict** (did the human accept it — borrowed
via a one-key yes/no, never computed). Machine checks (tests, typecheck, a repro that flips)
are **gates, not scores**: they stop coder from shipping something obviously broken; they
never count as the accuracy number. The north star is **time-to-confirmed-resolution**,
trending down — getting the user to a confident yes faster _is_ the product. To make that
yes cheap, every conclusion coder hands back is a **verdict** held to a verifiable standard
(below).

That's it. No task taxonomy, no per-category rubric, no fabricated score.

## Why it has to be this simple

No machine signal confirms a task was done _right_:

- **Pre-existing tests** catch regressions ("didn't break the documented contract") — but by
  definition there's no test yet for the _new_ requirement.
- **Agent-written tests are circular** — they encode the agent's own (maybe wrong)
  understanding, so green just launders that belief into false confidence. Not evidence.
- **Business / product / tacit nuance** is in no test, ever.

So machine checks are floors, never ceilings — for coding too. The only correctness signal
is the human's. We borrow it; we don't invent it. (The rule, unchanged from `PLAN.md`:
**never report an accuracy number we can't back up.**)

Two mechanics that keep it honest:

- **The unit is the resolution event, not the session.** One session has several
  (follow-ups, new sub-asks). Detect the acceptance moments; don't label whole sessions.
- **Get the verdict cheaply, never naggily** — one key; skip ⇒ "unknown", not a faked number.
  Backfill from behavior when not signed off: acted-on / moved-on = accepted; rephrased /
  pushed-back = rejected; **bailing on an unsigned result (Ctrl-C) = abandoned** (negative-ish,
  distinct from an explicit "no"). Read it in aggregate/trend — a single "yes" can be wrong
  in hindsight.

## The verdict standard

Because the human's yes is the only correctness signal, coder's job is to make it cheap to
give. The agent **uses automated and manual testing to reach** a conclusion (that's the
evidence); the conclusion's **quality is how little work the human needs to confirm it**. A
high-quality verdict:

- **Leads with the conclusion** — bottom line first, evidence after.
- **Concise** — fewest words that fully resolve it; length tracks stakes.
- **Reasoned from first principles** — from how this system actually works, not pattern-match.
- **Plain language** — no assumption-ridden jargon; say what actually happens.
- **Evidence-backed and navigable** — points to the `file:line` / output / diff to _open_,
  reproducible.
- **Confidence-tagged** — **checked** (ran it, saw it) vs **reasoned** vs **guess**; never blur them.
- **Bounded** — states what it did _not_ check / what's out of scope. This stops confidently-wrong.
- **Falsifiable** — says how to disconfirm it ("to verify, run X"; "wrong if Y").
- **Calibrated, not hedged** — "confident in the _where_, not the _why_", not "might possibly".

### Examples

**Where is Event X triggered / why status XYZ?**

> ✗ "After analyzing the codebase, the event is likely triggered in several places related
> to status handling, which could potentially explain the customer's concern."

> ✓ "Event X fires from one place: `src/events/dispatch.ts:142`, in `onOrderSettled()`.
> Status 409 comes from `api/orders.ts:88` — returned when an order is _already_ settled, so
> a retry hits it.
> **checked**: traced the path; reproduced the 409 by replaying a settle twice.
> **not checked**: that the customer's request was a retry — need their request log."

**Find root cause of $ERROR.**

> ✗ "Looks like a race condition or maybe a null reference. I've made changes that should fix it."

> ✓ "Root cause: `cache.get(id)` returns `undefined` for evicted keys, and `render()` reads
> `.title` on it (`render.ts:54`) → the TypeError.
> **checked**: reproduced by evicting then rendering; the guard I added at `:54` makes the repro pass.
> **guess**: that this is the customer's error — the stack matches, but I couldn't get their input."

**Coding change.**

> ✗ "Done! Implemented the feature and all tests pass."

> ✓ "Added `--json` (`cli.ts:30`, formatter `format.ts:12`).
> **checked**: 4 new tests + the existing suite pass; ran `coder --json`, output parses.
> **not verified**: that the field names match your downstream consumer — I mirrored the `--csv`
> shape; confirm before relying on it."

## What to build (in order)

1. **Effort counters** in the receipt (turns, tool calls, files read/written) — cheap,
   deterministic; the substrate.
2. **Floors as gates** — surface a regression/self-consistency failure; don't claim done.
3. **A verdict prompt** — one-key, skippable yes/no at the resolution event; behavior-backfill.
4. **The charter** holds coder to the verdict standard above (structural, not "please be concise").

## Deferred (refinements, not the core)

Useful later, explicitly _not_ part of the simple design:

- `f(turns, complexity)` as a **confidence/difficulty flag** — weights a real signal and
  flags thrash; never the accuracy itself.
- Richer process signals (repeated identical tool sequences ↔ the Distiller's input,
  self-corrections, verbosity spikes).
- **Calibration** — validate any proxy against the verdict subset before reporting a number.
- **Category labels** for _slicing reports_ — derived post-hoc from artifacts, never used as
  the measurement primitive.
