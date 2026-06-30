// Path guard for the agent's file tools — confine every tool path to the worktree:
// reject `..` and symlink escapes (PLAN R9). The tools themselves are AI SDK `tool()`
// objects in `agent/tools.ts`; this module owns only the resolution/containment rule.
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isInsideWorktree } from "coder-core";

/**
 * Resolve a tool path against the worktree root and enforce the path guard (R9):
 * reject both `..` escapes and **symlink** escapes. Lexical `resolve` alone is not
 * enough — a symlink inside the worktree pointing outside would pass it. We canonicalize
 * the worktree root and the deepest existing ancestor of the target (which resolves every
 * symlink in the existing prefix), then re-append any not-yet-created tail so writes to
 * new files are still checked against their *real* parent directory.
 */
export function safeResolve(worktreeRoot: string, relPath: string): string {
  const realRoot = realpathSync(worktreeRoot);
  const abs = resolve(realRoot, relPath); // collapses `..` lexically; absolute relPath wins

  // Walk up to the deepest path component that exists, collecting the missing tail.
  let existing = abs;
  const tail: string[] = [];
  while (!existsSync(existing)) {
    tail.unshift(basename(existing));
    const parent = dirname(existing);
    if (parent === existing) break; // filesystem root
    existing = parent;
  }
  const resolved = join(realpathSync(existing), ...tail); // realpath resolves any symlinks

  if (!isInsideWorktree(realRoot, resolved)) {
    throw new Error(`path escapes worktree: ${relPath}`);
  }
  return resolved;
}
