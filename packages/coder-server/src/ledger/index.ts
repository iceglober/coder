// Ledger — one receipt per task. Local, file-based, crash-safe (append-only JSONL,
// state derivable by replay). Source of truth for the status bar *and* the Distiller.
// Records the cost/token trio plus tokens-avoided, op-hit, and the accuracy signal.
// (The agent's mutable scratchpad is a *separate* store — see coder-core `Notes`.)
import { dirname, join } from "node:path";
import { appendEvent, readEvents, type Receipt, type Verdict } from "coder-core";

interface VerdictRecord {
  receiptId: string;
  verdict: Verdict;
}

export class Ledger {
  /** Human sign-offs live in a sibling file; the receipt store stays write-once. */
  private readonly verdictsPath: string;

  /** @param path JSONL file under the worktree (e.g. `.coder/ledger.jsonl`). */
  constructor(private readonly path: string) {
    this.verdictsPath = join(dirname(path), "verdicts.jsonl");
  }

  async record(receipt: Receipt): Promise<void> {
    await appendEvent(this.path, receipt.endedAt, receipt);
  }

  /** Attach a human sign-off to a past receipt. Append-only; last write wins; folded
   *  onto the receipt's `verdict` in `all()`. */
  async recordVerdict(receiptId: string, verdict: Verdict): Promise<void> {
    await appendEvent(this.verdictsPath, new Date().toISOString(), { receiptId, verdict });
  }

  async all(): Promise<Receipt[]> {
    const receipts = (await readEvents<Receipt>(this.path)).map((e) => e.data);
    const verdicts = await readEvents<VerdictRecord>(this.verdictsPath);
    if (verdicts.length) {
      const latest = new Map<string, Verdict>();
      for (const v of verdicts) latest.set(v.data.receiptId, v.data.verdict); // last wins
      for (const r of receipts) {
        const v = latest.get(r.id);
        if (v) r.verdict = v;
      }
    }
    return receipts;
  }

  /** The most-recent EXPLICIT sign-offs (accepted/rejected only), newest first, capped — backs the
   *  rejection steer so a sign-off changes the next turn instead of only feeding stats. */
  async recentSignoffs(limit = 6): Promise<Verdict[]> {
    const receipts = await this.all();
    const signed = receipts.filter((r) => r.verdict === "accepted" || r.verdict === "rejected");
    return signed
      .slice(-limit)
      .reverse()
      .map((r) => r.verdict);
  }

  /** How many of the most-recent signed-off turns were REJECTED in a row (0 if the last was
   *  accepted). 1 ⇒ "don't repeat that approach"; ≥2 ⇒ "change strategy, stop guessing". */
  async rejectionStreak(): Promise<number> {
    let n = 0;
    for (const v of await this.recentSignoffs()) {
      if (v === "rejected") n += 1;
      else break;
    }
    return n;
  }

  /** Rollup for the status bar: totals + verdict mix + average effort across all receipts. */
  async rollup(): Promise<LedgerRollup> {
    const receipts = await this.all();
    const acc: LedgerRollup = {
      tasks: receipts.length,
      costUsd: 0,
      tokensAvoided: 0,
      opHits: 0,
      verdicts: { accepted: 0, rejected: 0, abandoned: 0, unknown: 0 },
      avgTurns: 0,
      avgToolCalls: 0,
      timeouts: 0,
      toolMs: 0,
    };
    let turns = 0;
    let toolCalls = 0;
    for (const r of receipts) {
      acc.costUsd += r.costUsd;
      acc.tokensAvoided += r.tokensAvoided;
      if (r.opHit) acc.opHits += 1;
      acc.verdicts[r.verdict] += 1;
      turns += r.effort.turns;
      toolCalls += r.effort.toolCalls;
      acc.timeouts += r.effort.timeouts;
      acc.toolMs += r.effort.toolMs;
    }
    if (receipts.length) {
      acc.avgTurns = turns / receipts.length;
      acc.avgToolCalls = toolCalls / receipts.length;
    }
    return acc;
  }
}

export interface LedgerRollup {
  tasks: number;
  costUsd: number;
  tokensAvoided: number;
  /** How many tasks a deterministic operation answered, skipping the model. */
  opHits: number;
  /** Borrowed human verdicts across all tasks (the only correctness signal). */
  verdicts: Record<"accepted" | "rejected" | "abandoned" | "unknown", number>;
  /** Average computed effort per task. */
  avgTurns: number;
  avgToolCalls: number;
  /** Total command timeouts across all tasks — chronic timeouts ⇒ a check that needs setup. */
  timeouts: number;
  /** Total wall-clock spent inside tools across all tasks, ms — the time tokens don't show. */
  toolMs: number;
}
