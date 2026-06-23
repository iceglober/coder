// Distiller — background agent mining the Ledger for *inference waste*. Detection is
// free (heuristics); only ROI-positive candidates are synthesized on the cheap tier
// under a token budget, replay-validated against real history, then *proposed* — never
// auto-registered (PLAN R5, N6). Runs on idle / schedule / `/distill`.
import type { Proposal, Receipt } from "coder-core";

export interface DistillerBudget {
  /** Bounded per-run synthesis budget in output tokens (N6). */
  maxSynthTokens: number;
  /** ROI gate multiplier: register only if freq×saved ≥ payback×synthCost. */
  payback: number;
}

export interface WasteCandidate {
  /** Intent signature shared across receipts (e.g. "derive PR state"). */
  intent: string;
  frequency: number;
  /** Estimated tokens a det would save per occurrence. */
  tokensSavedEach: number;
}

/** Free heuristic detection — no model call. Same intent → same deterministic sequence;
 * high freq × cost; outcome independent of reasoning; repeated verbose derivations. */
export function detectWaste(receipts: Receipt[]): WasteCandidate[] {
  const byClass = new Map<string, { freq: number; saved: number }>();
  for (const r of receipts) {
    const cur = byClass.get(r.taskClass) ?? { freq: 0, saved: 0 };
    cur.freq += 1;
    cur.saved += r.outputTokens; // crude proxy; refined in P3
    byClass.set(r.taskClass, cur);
  }
  return [...byClass.entries()].map(([intent, v]) => ({
    intent,
    frequency: v.freq,
    tokensSavedEach: v.freq > 0 ? Math.round(v.saved / v.freq) : 0,
  }));
}

/** ROI gate: freq × tokensSaved ≥ payback × synthCost (PLAN R5). */
export function isRoiPositive(c: WasteCandidate, synthCost: number, budget: DistillerBudget): boolean {
  return c.frequency * c.tokensSavedEach >= budget.payback * synthCost;
}

// TODO(P3): scope detection to structural signatures (identical normalized tool-call
// sequences) — the genuinely-free subset. Synthesize ROI-positive candidates on the
// cheap tier under budget, replay-validate against recorded input→output fixtures,
// dedup against the existing operation corpus, then emit Proposals into
// `.coder/proposals/`. Anything synthesized starts on trust "probation" and earns trust
// only via shadow checks — never auto-registered as authoritative. See docs/PLAN.md.
export type DistillerProposal = Proposal;
