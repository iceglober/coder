import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeResolve } from "../src/tools/index.ts";

// R9: tools are confined to the worktree — reject `..` AND symlink escapes.
describe("safeResolve confines to the worktree", () => {
  let root: string;
  let outside: string;

  beforeAll(() => {
    // realpath so comparisons are against canonical paths (macOS /tmp → /private/tmp).
    root = realpathSync(mkdtempSync(join(tmpdir(), "coder-root-")));
    outside = realpathSync(mkdtempSync(join(tmpdir(), "coder-out-")));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "x");
    writeFileSync(join(outside, "secret.txt"), "s");
    symlinkSync(outside, join(root, "escape")); // dir symlink → outside the worktree
    symlinkSync(join(outside, "secret.txt"), join(root, "leak.txt")); // file symlink → outside
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  test("allows a real file inside", () => {
    expect(safeResolve(root, "src/a.ts")).toBe(join(root, "src", "a.ts"));
  });

  test("allows a not-yet-created file inside (checked against its real parent)", () => {
    expect(safeResolve(root, "src/new.ts")).toBe(join(root, "src", "new.ts"));
  });

  test("rejects a `..` escape", () => {
    expect(() => safeResolve(root, "../../etc/passwd")).toThrow(/escapes worktree/);
  });

  test("rejects an absolute path outside", () => {
    expect(() => safeResolve(root, outside)).toThrow(/escapes worktree/);
  });

  test("rejects a symlinked file that points outside", () => {
    expect(() => safeResolve(root, "leak.txt")).toThrow(/escapes worktree/);
  });

  test("rejects writing through a symlinked dir that points outside", () => {
    expect(() => safeResolve(root, "escape/evil.txt")).toThrow(/escapes worktree/);
  });
});
