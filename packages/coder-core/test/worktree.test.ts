import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { assertPrimaryClone, createWorktree, listWorktrees, removeWorktree } from "../src/worktree.ts";

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

  test("assertPrimaryClone refuses to nest worktrees", async () => {
    await expect(assertPrimaryClone(repo)).resolves.toBeUndefined(); // primary clone → fine
    const wt = await createWorktree(repo, { branch: "coder/wt-nest" });
    await expect(assertPrimaryClone(wt.path)).rejects.toThrow(/linked worktree/); // from inside a worktree → refuse
    await removeWorktree(repo, wt, { deleteBranch: true });
  });
});
