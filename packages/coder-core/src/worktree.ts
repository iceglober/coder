// Worktree + git glue. The worktree is coder's unit of work (1:1 with a branch);
// both the chat and shell panes are pinned to it. Reimplemented clean from glrs
// prior art (`packages/cli/src/lib/worktree.ts`) — reference only, never imported.

import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface Worktree {
  /** Absolute path to the worktree directory. */
  path: string;
  branch: string;
  /** True for the primary clone (not a linked worktree). */
  isPrimary: boolean;
  /** Commit the worktree was branched from (set by `createWorktree`). The reference point for
   *  `worktreeHasChanges` — "has anything happened here since it was created?". */
  base?: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd });
  return stdout.trim();
}

/** Current branch of the worktree at `dir`. */
export async function currentBranch(dir: string): Promise<string> {
  return git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

/** True when `dir` has uncommitted changes (staged, unstaged, or untracked). Used to warn that a
 *  fresh worktree — branched off HEAD — won't include the primary checkout's in-flight edits. */
export async function hasUncommittedChanges(dir: string): Promise<boolean> {
  return !!(await git(dir, ["status", "--porcelain"]).catch(() => ""));
}

/** List all worktrees of the repo containing `dir` (parsed from porcelain output). */
export async function listWorktrees(dir: string): Promise<Worktree[]> {
  const out = await git(dir, ["worktree", "list", "--porcelain"]);
  const trees: Worktree[] = [];
  let path = "";
  let branch = "";
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line.startsWith("branch ")) branch = line.slice("branch ".length).replace("refs/heads/", "");
    else if (line === "") {
      if (path) trees.push({ path, branch, isPrimary: trees.length === 0 });
      path = "";
      branch = "";
    }
  }
  if (path) trees.push({ path, branch, isPrimary: trees.length === 0 });
  return trees;
}

/**
 * Reject paths that escape the worktree root (PLAN R9: confine tools to the worktree;
 * reject `..`/symlink). Path-guard used by every file tool.
 */
export function isInsideWorktree(root: string, candidate: string): boolean {
  const normalizedRoot = root.endsWith("/") ? root : root + "/";
  return candidate === root || candidate.startsWith(normalizedRoot);
}

/** Refuse to branch a worktree off a worktree. coder is meant to run from the primary clone; nesting
 *  linked worktrees confuses git + the per-worktree `.coder/`. Throws if `root` is itself a LINKED
 *  worktree (callers may catch + warn for the interactive case). No-op when `root` isn't a git repo. */
export async function assertPrimaryClone(root: string): Promise<void> {
  const trees = await listWorktrees(root).catch(() => [] as Worktree[]);
  if (!trees.length) return;
  const here = await git(root, ["rev-parse", "--show-toplevel"]).catch(() => root);
  const self = trees.find((t) => t.path === here);
  if (self && !self.isPrimary) {
    const primary = trees.find((t) => t.isPrimary)?.path ?? "the primary clone";
    throw new Error(`refusing to create a worktree inside a linked worktree (${here}). Run from ${primary}.`);
  }
}

/** Create an isolated worktree + branch off `base` (default HEAD). Self-contained: plain `git worktree
 *  add`, no glrs. The worktree lives under `~/.coder/worktrees/<repo>/<branch-slug>` so it never dirties
 *  the repo or its parent. The caller reviews/merges the branch; the harness removes it after. */
export async function createWorktree(root: string, opts: { branch?: string; base?: string } = {}): Promise<Worktree> {
  await assertPrimaryClone(root);
  const branch = opts.branch ?? `coder/wt-${Date.now()}`;
  const base = opts.base ?? "HEAD";
  const baseSha = await git(root, ["rev-parse", base]).catch(() => ""); // recorded for later "has it changed?"
  const slug = branch.replace(/[^\w.-]+/g, "-");
  const path = join(homedir(), ".coder", "worktrees", basename(root), slug);
  await mkdir(dirname(path), { recursive: true });
  await git(root, ["worktree", "add", "-b", branch, path, base]);
  return { path, branch, isPrimary: false, base: baseSha };
}

export interface ReapResult {
  /** The worktree DIRECTORY was removed. */
  removed: boolean;
  /** The branch was retained (it holds work) rather than deleted. */
  branchKept: boolean;
  /** Uncommitted changes were captured as a WIP commit before removal, so nothing was lost. */
  committed: boolean;
  /** When `removed` is false, why — so the caller can report it instead of silently leaving it. */
  reason?: string;
}

/**
 * Reap a tab's worktree: always remove the DIRECTORY, keep the BRANCH when it holds work.
 *
 * The directory is the clutter; the branch is the value. But uncommitted changes live only in the
 * directory — so if the worktree is dirty we first commit them as a WIP snapshot, then remove the
 * directory. The branch is kept when it has any work (a commit past `base`, including the WIP one we
 * just made) and deleted when the worktree was never touched (no empty branch left behind).
 *
 * Safe by construction: if anything fails (e.g. no git identity to commit with), it removes nothing
 * and returns `{ removed: false, reason }`, so the caller keeps + reports it rather than losing work.
 */
export async function reapWorktree(root: string, wt: Pick<Worktree, "path" | "branch" | "base">): Promise<ReapResult> {
  try {
    let committed = false;
    if (await git(wt.path, ["status", "--porcelain"])) {
      await git(wt.path, ["add", "-A"]);
      await git(wt.path, ["commit", "-q", "--no-verify", "-m", "coder: WIP snapshot before worktree reap"]);
      committed = true;
    }
    const hasWork = wt.base ? (await git(wt.path, ["rev-list", "--count", `${wt.base}..HEAD`])) !== "0" : committed;
    await git(root, ["worktree", "remove", "--force", wt.path]);
    if (!hasWork) await git(root, ["branch", "-D", wt.branch]).catch(() => {});
    return { removed: true, branchKept: hasWork, committed };
  } catch (err) {
    return { removed: false, branchKept: true, committed: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Remove a worktree created by `createWorktree` (and optionally delete its branch). `--force` so a
 *  dirty worktree is still reaped — the changes are the point, but disposal is the caller's intent. */
export async function removeWorktree(root: string, wt: Pick<Worktree, "path" | "branch">, opts: { deleteBranch?: boolean } = {}): Promise<void> {
  await git(root, ["worktree", "remove", "--force", wt.path]);
  if (opts.deleteBranch) await git(root, ["branch", "-D", wt.branch]).catch(() => {});
}
