// Deterministic operations — the one building block. Plain code: input → structured
// output, no model call. "Capabilities" and "Extractors" were the same thing seen from
// two angles, so there's one primitive here, exposed on one or more surfaces.
//
// local operations answer fast with no network (the <100ms promise); remote ones run
// host-side, hold credentials, and can fail. Filters auto-reduce a noisy tool's output
// before it reaches context. See docs/PLAN.md.
import { type Tool, tool, type ToolSet } from "ai";
import { z } from "zod";
import type { OpSpec, Surface } from "coder-core";

export interface OpContext {
  /** Worktree root — local operations resolve relative to it. */
  worktreeRoot: string;
}

/** A structured signal a filter can extract from tool output (feeds the receipt). */
export type OperationSignal = { kind: "tests"; passed: boolean; failed: number; total: number };

/** What a filter-surface operation produces from a noisy tool's raw output. */
export interface FilterResult {
  /** Text to put in context in place of the raw output (may equal the input). */
  text: string;
  /** True iff the filter recognized the output and produced a summary/signal. */
  applied: boolean;
  /** Structured signal extracted, if any (e.g. tests pass/fail). */
  signal?: OperationSignal;
}

/**
 * A runnable operation: its spec plus a deterministic handler. Tool-surface ops carry a
 * Zod `parameters` schema + `run`; filter-surface ops carry `filter`. (Both are optional
 * so an op only implements the surfaces it exposes.)
 */
export interface Operation<Input = unknown, Output = unknown> {
  spec: OpSpec;
  /** Input schema for the `tool` surface. */
  parameters?: z.ZodType<Input>;
  /** Deterministic execution: input → structured output, no model. */
  run?(input: Input, ctx: OpContext): Promise<Output>;
  /** `filter` surface: reduce a bound tool's raw output before it enters context. */
  filter?(output: string): FilterResult;
}

function hasSurface(spec: OpSpec, kind: Surface["kind"]): boolean {
  return spec.surfaces.some((s) => s.kind === kind);
}

/** In-memory registry of operations, indexed by name and by the tool they filter. */
export class OperationRegistry {
  private readonly byName = new Map<string, Operation>();

  register(op: Operation): void {
    this.byName.set(op.spec.name, op as Operation);
  }

  /** The filter operation bound to a given tool's output, if any (old "Extractor"). */
  filterFor(tool: string): Operation | undefined {
    for (const op of this.byName.values()) {
      if (op.spec.surfaces.some((s) => s.kind === "filter" && s.boundTo === tool)) return op;
    }
    return undefined;
  }

  /** Operations exposed as tools — the only ones offered to the model. */
  tools(): Operation[] {
    return [...this.byName.values()].filter((op) => hasSurface(op.spec, "tool"));
  }

  /** Relevance search backing the `find_capability` meta-tool (top-N). */
  find(query: string, limit = 5): OpSpec[] {
    const q = query.toLowerCase();
    return [...this.byName.values()]
      .map((op) => op.spec)
      .filter((s) => s.name.includes(q) || s.description.toLowerCase().includes(q))
      .slice(0, limit);
  }
}

/** Wrap a tool-surface operation as an AI SDK tool: deterministic run → structured JSON. */
export function operationTool(op: Operation, ctx: OpContext): Tool {
  return tool({
    description: op.spec.description,
    inputSchema: op.parameters ?? z.object({}),
    execute: async (input: unknown) => {
      try {
        const out = await op.run?.(input, ctx);
        return typeof out === "string" ? out : JSON.stringify(out ?? {});
      } catch (err) {
        return `error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}

/** Build an AI SDK ToolSet from the tool-surface operations, keyed by name. */
export function operationToolSet(ops: Operation[], ctx: OpContext): ToolSet {
  const set: ToolSet = {};
  for (const op of ops) set[op.spec.name] = operationTool(op, ctx);
  return set;
}

/**
 * Per-run sink for what computation bought us: structured signals (e.g. the last test
 * result, which becomes the receipt's accuracy signal) and tokens kept out of context by
 * filters. The runner reads it after the turn.
 */
export class RunSignals {
  lastTest?: Extract<OperationSignal, { kind: "tests" }>;
  tokensAvoided = 0;
  /** How many times a command keyed by `key` (a task name, or a bash command) hit the timeout. */
  private readonly timeoutsByKey = new Map<string, number>();

  record(sig: OperationSignal): void {
    if (sig.kind === "tests") this.lastTest = sig;
  }

  /** Count characters a filter kept out of context as ~tokens (≈4 chars/token). */
  avoided(chars: number): void {
    if (chars > 0) this.tokensAvoided += Math.round(chars / 4);
  }

  /** A command keyed by `key` just timed out. */
  recordTimeout(key: string): void {
    this.timeoutsByKey.set(key, (this.timeoutsByKey.get(key) ?? 0) + 1);
  }

  /** How many times `key` has already timed out this run — the guard reads this before re-running. */
  timedOutBefore(key: string): number {
    return this.timeoutsByKey.get(key) ?? 0;
  }

  /** Total timeouts this run, for the receipt's effort. */
  get totalTimeouts(): number {
    let n = 0;
    for (const c of this.timeoutsByKey.values()) n += c;
    return n;
  }
}
