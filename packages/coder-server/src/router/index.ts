// Dispatcher — looks at the input and picks the cheapest way to answer:
//   a deterministic operation (0 model tokens), a `/`-command, or the model.
// Model turns start on the cheapest capable tier and escalate only on a real
// verify failure. See docs/PLAN.md.
import type { Classification, Tier } from "coder-core";

export interface RouteDecision {
  classification: Classification;
  /** Set when classification === "operation": the op to run with zero model tokens. */
  operation?: string;
  /** Set when classification === "command": the `/`-command name. */
  command?: string;
  /** Set when classification === "free-text": the cheapest tier to start at. */
  tier?: Tier;
}

export interface DispatcherDeps {
  /** Names of registered operations, used to match deterministic intents. */
  operationNames: Set<string>;
  /** Whether a free-text intent maps deterministically to an operation. */
  matchOperation(text: string): string | undefined;
}

export function classify(input: string, deps: DispatcherDeps): RouteDecision {
  const trimmed = input.trim();

  if (trimmed.startsWith("/")) {
    return { classification: "command", command: trimmed.slice(1).split(/\s+/)[0] };
  }

  const op = deps.matchOperation(trimmed);
  if (op && deps.operationNames.has(op)) {
    return { classification: "operation", operation: op };
  }

  // Free-text → cheapest tier by default; escalation happens downstream.
  return { classification: "free-text", tier: "cheap" };
}

/**
 * Tier bump on a real verify failure (tests/typecheck failed). A verbosity spike is
 * *not* an escalation trigger — it's only flagged as an uncertainty signal and fed to
 * the Distiller, so we never pay a pricier tier on a noisy proxy. See docs/PLAN.md.
 */
export function escalate(current: Tier): Tier {
  const order: Tier[] = ["cheap", "fast", "mid", "deep"];
  const i = order.indexOf(current);
  return order[Math.min(i + 1, order.length - 1)];
}
