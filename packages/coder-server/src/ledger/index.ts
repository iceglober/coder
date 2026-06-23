// Ledger — one receipt per task. Local, file-based, crash-safe (append-only JSONL,
// state derivable by replay). Source of truth for the status bar *and* the Distiller.
// Records the cost/token trio plus tokens-avoided, op-hit, and the accuracy signal.
// (The agent's mutable scratchpad is a *separate* store — see coder-core `Notes`.)
import { appendEvent, readEvents, type Receipt } from "coder-core";

export class Ledger {
  /** @param path JSONL file under the worktree (e.g. `.coder/ledger.jsonl`). */
  constructor(private readonly path: string) {}

  async record(receipt: Receipt): Promise<void> {
    await appendEvent(this.path, receipt.endedAt, receipt);
  }

  async all(): Promise<Receipt[]> {
    const entries = await readEvents<Receipt>(this.path);
    return entries.map((e) => e.data);
  }

  /** Rollup for the status bar: totals across all receipts. */
  async rollup(): Promise<LedgerRollup> {
    const receipts = await this.all();
    const acc: LedgerRollup = {
      tasks: receipts.length,
      costUsd: 0,
      tokensAvoided: 0,
      opHits: 0,
    };
    for (const r of receipts) {
      acc.costUsd += r.costUsd;
      acc.tokensAvoided += r.tokensAvoided;
      if (r.opHit) acc.opHits += 1;
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
}
