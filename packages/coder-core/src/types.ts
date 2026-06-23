// Shared domain types for coder. Pure data shapes — no runtime deps.
// These are the contracts every package agrees on; behavior lives in coder-server.

/** Model tiers, cheapest-first. The dispatcher picks the cheapest capable tier. */
export type Tier = "cheap" | "fast" | "mid" | "deep";

/** Normalized output-control setting (see output control in docs/PLAN.md). */
export type Succinctness = "low" | "normal" | "high";

// ── Deterministic operations ────────────────────────────────────────────────
// One building block. "Capabilities" and "Extractors" were the same thing seen
// from two angles; they're unified here. An operation is plain code: input →
// structured output, no model call. It has four independent properties.

/** Where an operation is triggered. An operation may expose several surfaces. */
export type Surface =
  /** A `/`-command the user types. Zero model tokens. */
  | { kind: "command"; name: string }
  /** A tool the agent calls. Cheap (schema + call), not free; no reasoning chain. */
  | { kind: "tool" }
  /** Auto-applied to a noisy tool's output before context (the old "Extractor"). */
  | { kind: "filter"; boundTo: string }
  /** The dispatcher matches intent → operation directly. Zero model tokens. */
  | { kind: "route" };

/** local = fast, no network, runs anywhere. remote = network + creds, host-only, fallible. */
export type Locality = "local" | "remote";

/** Trust is earned, not granted. People decide what exists; evidence decides trust. */
export type Trust = "builtin" | "probation" | "trusted";

/** Almost all operations read; a few write (a deterministic code transform). */
export type Effect = "read" | "write";

/**
 * Spec for a deterministic operation. Stored as a file under `.coder/operations/<name>`;
 * the runnable transform + input schema live in coder-server.
 */
export interface OpSpec {
  name: string;
  /** One-line description used for relevance gating / dispatch. */
  description: string;
  locality: Locality;
  effect: Effect;
  trust: Trust;
  surfaces: Surface[];
  /** Present iff the operation was machine-written by the Distiller. */
  provenance?: Provenance;
}

/** Where a machine-written operation came from — receipts that justify it. */
export interface Provenance {
  /** Receipt ids the Distiller mined to synthesize this operation. */
  receiptIds: string[];
  synthesizedAt?: string;
}

// ── Measurement ─────────────────────────────────────────────────────────────

/** The one accuracy signal we can stand behind for a given task — never a faked number. */
export type AccuracySignal =
  /** Code change: objective pass/fail from tests/typecheck. */
  | { kind: "tests"; passed: boolean }
  /** Deterministic op: did the op and the model agree on a shadow check? */
  | { kind: "shadow"; agreed: boolean }
  /** Free-text: no ground truth; carry the uncertainty signal instead. */
  | { kind: "unverified"; verbosityRatio?: number };

/** One receipt per task — append-only, crash-safe. Feeds the status bar + Distiller. */
export interface Receipt {
  id: string;
  taskClass: string;
  tier: Tier;
  /** Did a deterministic operation answer this, skipping the model? */
  opHit: boolean;
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  costUsd: number;
  /** Tokens we avoided by computing instead of inferring. */
  tokensAvoided: number;
  /** The accuracy signal that actually applies to this task. */
  accuracy: AccuracySignal;
  startedAt: string;
  endedAt: string;
}

// ── Proposals & registry ────────────────────────────────────────────────────

/** A Distiller proposal awaiting human review. Lands in `.coder/proposals/`. */
export interface Proposal {
  id: string;
  spec: OpSpec;
  /** Projected net savings: freq × tokensSaved − payback × synthCost. */
  projectedRoi: number;
  /** Replay of the synthesized operation against recorded input→output examples. */
  replay: ReplayResult;
}

export interface ReplayResult {
  passed: boolean;
  fixturesRun: number;
  fixturesPassed: number;
  notes?: string;
}

/** Live registry stats aggregated from receipts (`.coder/registry.json`). */
export interface RegistryEntry {
  name: string;
  /** project-level operations win over global (~/.coder). */
  scope: "project" | "global";
  trust: Trust;
  hits: number;
  tokensAvoided: number;
  lastUsedAt?: string;
}

/** How the dispatcher classified an intake. */
export type Classification = "operation" | "command" | "free-text";
