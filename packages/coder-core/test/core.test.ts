import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isInsideWorktree, mergeRegistries, Notes, Routes } from "../src/index.ts";

describe("worktree path guard", () => {
  test("accepts paths inside the root", () => {
    expect(isInsideWorktree("/wt/repo", "/wt/repo/src/a.ts")).toBe(true);
    expect(isInsideWorktree("/wt/repo", "/wt/repo")).toBe(true);
  });

  test("rejects escapes", () => {
    expect(isInsideWorktree("/wt/repo", "/wt/repo-evil/x")).toBe(false);
    expect(isInsideWorktree("/wt/repo", "/etc/passwd")).toBe(false);
  });
});

describe("registry precedence", () => {
  test("project entries shadow global on name collision", () => {
    const reg = mergeRegistries(
      [{ name: "pr_status", scope: "project", trust: "builtin", hits: 3, tokensAvoided: 100 }],
      [{ name: "pr_status", scope: "global", trust: "trusted", hits: 9, tokensAvoided: 999 }],
    );
    expect(reg.resolve("pr_status")?.scope).toBe("project");
    expect(reg.entries).toHaveLength(1);
  });
});

describe("notes scratchpad", () => {
  test("reduces the append-only log to a last-write-wins view", async () => {
    const path = join(tmpdir(), `coder-notes-${process.pid}-${performance.now()}.jsonl`);
    const notes = new Notes(path);
    await notes.set("2026-01-01T00:00:00Z", "plan", "step 1");
    await notes.set("2026-01-01T00:00:01Z", "plan", "step 2");
    await notes.set("2026-01-01T00:00:02Z", "scratch", "x");
    await notes.delete("2026-01-01T00:00:03Z", "scratch");
    const view = await notes.view();
    expect(view.get("plan")).toBe("step 2");
    expect(view.has("scratch")).toBe(false);
  });
});

describe("protocol routes", () => {
  test("build session-scoped paths", () => {
    expect(Routes.events("abc")).toBe("/session/abc/events");
    expect(Routes.permission("abc", "p1")).toBe("/session/abc/permission/p1");
  });
});
