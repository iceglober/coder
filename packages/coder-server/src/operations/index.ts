// Deterministic operations — the one building block. Plain code: input → structured
// output, no model call. "Capabilities" and "Extractors" were the same thing seen from
// two angles, so there's one primitive here, exposed on one or more surfaces.
//
// local operations answer fast with no network (the <100ms promise); remote ones run
// host-side, hold credentials, and can fail. Filters auto-reduce a noisy tool's output
// before it reaches context. See docs/PLAN.md.
import type { OpSpec, Surface } from "coder-core";

export interface OpContext {
  /** Worktree root — local operations resolve relative to it. */
  worktreeRoot: string;
}

/** A runnable operation: its spec + a deterministic handler. */
export interface Operation<Input = unknown, Output = unknown> {
  spec: OpSpec;
  run(input: Input, ctx: OpContext): Promise<Output>;
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

  get(name: string): Operation | undefined {
    return this.byName.get(name);
  }

  names(): Set<string> {
    return new Set(this.byName.keys());
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

// TODO(P1): first built-in local operations — git_state, find_def, and a test-output
// filter. TODO(P3): remote operations (pr_status, CI test_results) running host-side.
