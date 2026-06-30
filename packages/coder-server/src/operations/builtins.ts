// The built-in operations registered for every run. P1 is a plain list — no relevance
// gating, no self-written ops (those are P3). git_state + find_def are offered to the
// model as tools; test_summary filters bash output. See docs/PLAN.md §"Build order" P1.
import { findDef } from "./find-def.ts";
import { gitState } from "./git-state.ts";
import { OperationRegistry, type Operation } from "./index.ts";
import { testFilter } from "./test-filter.ts";

export function builtinOperations(): Operation[] {
  return [gitState, findDef, testFilter];
}

/** A registry preloaded with the built-ins. */
export function builtinRegistry(): OperationRegistry {
  const reg = new OperationRegistry();
  for (const op of builtinOperations()) reg.register(op);
  return reg;
}
