import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { assertPrimaryClone, createWorktree, hasUncommittedChanges, listWorktrees, reapWorktree, removeWorktree } from "../src/worktree.ts";

describe("worktree create/remove", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "coder-wt-"));
    const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo });
    git(["init", "-q"]);
    git(["config", "user.email", "t@t"]);
    git(["config", "user.name", "t"]);
    await writeFile(join(repo, "a.txt"), "hi");
    git(["add", "-A"]);
    git(["commit", "-qm", "init"]);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(join(homedir(), ".coder", "worktrees", basename(repo)), { recursive: true, force: true });
  });

  const branchExists = (name: string): boolean => Bun.spawnSync(["git", "branch", "--list", name], { cwd: repo }).stdout.toString().trim() !== "";

  test("create → branch + checked-out path; remove → gone", async () => {
    const wt = await createWorktree(repo, { branch: "coder/wt-test" });
    expect(wt.branch).toBe("coder/wt-test");
    expect(wt.isPrimary).toBe(false);
    expect((await stat(join(wt.path, "a.txt"))).isFile()).toBe(true); // the commit is checked out
    expect((await listWorktrees(repo)).some((t) => t.path === wt.path)).toBe(true);

    await removeWorktree(repo, wt, { deleteBranch: true });
    await expect(stat(wt.path)).rejects.toThrow(); // directory gone
    expect((await listWorktrees(repo)).some((t) => t.path === wt.path)).toBe(false);
  });

  test("hasUncommittedChanges: clean repo → false, after an edit → true", async () => {
    expect(await hasUncommittedChanges(repo)).toBe(false); // committed in beforeEach
    await writeFile(join(repo, "dirty.txt"), "x");
    expect(await hasUncommittedChanges(repo)).toBe(true);
  });

  test("reapWorktree: untouched → dir + branch gone (no clutter left behind)", async () => {
    const wt = await createWorktree(repo, { branch: "coder/wt-empty" });
    const r = await reapWorktree(repo, wt);
    expect(r).toMatchObject({ removed: true, branchKept: false, committed: false });
    await expect(stat(wt.path)).rejects.toThrow(); // directory gone
    expect(branchExists("coder/wt-empty")).toBe(false); // empty branch not kept
  });

  test("reapWorktree: dirty → WIP-committed, dir removed, branch KEPT with the work", async () => {
    const wt = await createWorktree(repo, { branch: "coder/wt-dirty" });
    await writeFile(join(wt.path, "b.txt"), "uncommitted work");
    const r = await reapWorktree(repo, wt);
    expect(r).toMatchObject({ removed: true, branchKept: true, committed: true });
    await expect(stat(wt.path)).rejects.toThrow(); // directory always removed
    expect(branchExists("coder/wt-dirty")).toBe(true); // branch kept
    // the WIP commit preserved the file on the branch — verify it's reachable from the kept branch
    const show = Bun.spawnSync(["git", "show", "coder/wt-dirty:b.txt"], { cwd: repo });
    expect(show.stdout.toString()).toBe("uncommitted work");
    Bun.spawnSync(["git", "branch", "-D", "coder/wt-dirty"], { cwd: repo });
  });

  test("assertPrimaryClone refuses to nest worktrees", async () => {
    await expect(assertPrimaryClone(repo)).resolves.toBeUndefined(); // primary clone → fine
    const wt = await createWorktree(repo, { branch: "coder/wt-nest" });
    await expect(assertPrimaryClone(wt.path)).rejects.toThrow(/linked worktree/); // from inside a worktree → refuse
    await removeWorktree(repo, wt, { deleteBranch: true });
  });
});
