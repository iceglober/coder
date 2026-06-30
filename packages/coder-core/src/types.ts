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

/** What a tool/operation does to the world:
 *  - read   — observes only (read_file, grep, git_state).
 *  - verify — runs the project's own checks (test/typecheck/lint); no source edits.
 *  - write  — edits files or runs arbitrary commands (edit_file, bash).
 *  A subagent's role is a filtered view over these (the investigator = read + verify), and the
 *  permission policy gates by them. */
export type Effect = "read" | "verify" | "write";

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
// We measure effort (computed) and borrow a verdict (the human). Machine checks are
// gates, not scores — coder never grades its own correctness. See docs/accuracy.md.

/** Deterministic effort to reach the endpoint — the always-available half. */
export interface Effort {
  /** Model calls (steps) this task took. */
  turns: number;
  toolCalls: number;
  /** Distinct files read / written. */
  filesRead: number;
  filesWritten: number;
  /** Tool calls that exactly repeated an earlier one this task — a thrash signal (the model
   *  re-running the same thing for no new info). Measured, never acted on mid-loop; feeds the
   *  Distiller and low-confidence flags. The cure is a better tool (one call that answers), not a nudge. */
  repeatedCalls: number;
  /** Command tools (script/bash) that hit the wall-clock timeout and were killed. A few of these
   *  mean a check doesn't complete in this environment (needs setup, or wrong scope). */
  timeouts: number;
  /** Total wall-clock spent inside tools this task, ms — the time the user actually waited, which
   *  token cost hides (a timed-out test is cheap in tokens, expensive in minutes). */
  toolMs: number;
}

/** Machine gate results — floors ("not obviously broken"), NOT a correctness score. */
export interface Checks {
  /** Result of a test run the agent triggered this task, if any. */
  tests?: "pass" | "fail";
}

/** The only correctness signal — borrowed from the human, never computed.
 *  - accepted / rejected: explicit sign-off (the human said yes / no).
 *  - abandoned: the human bailed on an unsigned result (e.g. Ctrl-C). Behavioral, negative-ish.
 *  - unknown: no signal at all (left via /exit or EOF without signing off). Never faked. */
export type Verdict = "accepted" | "rejected" | "abandoned" | "unknown";

/** One receipt per task — append-only, crash-safe. Feeds the status bar + Distiller. */
export interface Receipt {
  id: string;
  taskClass: string;
  tier: Tier;
  /** The concrete model that ran (absent when a deterministic operation answered). */
  modelId?: string;
  /** Why the turn stopped (e.g. "stop", "tool-calls", "length", "operation"). */
  finishReason?: string;
  /** Did a deterministic operation answer this, skipping the model? */
  opHit: boolean;
  inputTokens: number;
  outputTokens: number;
  /** Provider's total token count — the source of truth for billing; may exceed
   *  input+output when the provider hides a breakdown (e.g. thinking tokens). */
  totalTokens?: number;
  cachedTokens?: number;
  costUsd: number;
  /** Tokens we avoided by computing instead of inferring. */
  tokensAvoided: number;
  /** Deterministic effort to the endpoint. */
  effort: Effort;
  /** Machine gate results (floors), if any ran. Not a correctness measure. */
  checks?: Checks;
  /** Borrowed human verdict — the correctness signal. "unknown" until captured. */
  verdict: Verdict;
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
