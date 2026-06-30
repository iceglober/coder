import { describe, expect, test } from "bun:test";
import { definitionPattern, parseDefMatches } from "../src/operations/find-def.ts";
import { parseGitStatus } from "../src/operations/git-state.ts";
import { parseTestOutput, testFilter } from "../src/operations/test-filter.ts";

describe("git_state parsing", () => {
  test("parses branch, ahead/behind, and file states", () => {
    const s = parseGitStatus("## main...origin/main [ahead 1, behind 2]\n M src/a.ts\nM  src/b.ts\nMM src/c.ts\n?? new.txt\n");
    expect(s.branch).toBe("main");
    expect(s.upstream).toBe("origin/main");
    expect(s.ahead).toBe(1);
    expect(s.behind).toBe(2);
    expect(s.staged.sort()).toEqual(["src/b.ts", "src/c.ts"]);
    expect(s.unstaged.sort()).toEqual(["src/a.ts", "src/c.ts"]);
    expect(s.untracked).toEqual(["new.txt"]);
    expect(s.clean).toBe(false);
  });

  test("a clean repo with no upstream", () => {
    const s = parseGitStatus("## work\n");
    expect(s.branch).toBe("work");
    expect(s.upstream).toBeUndefined();
    expect(s.clean).toBe(true);
  });
});

describe("find_def pattern", () => {
  test("matches declarations of the exact symbol, not substrings", () => {
    const re = new RegExp(definitionPattern("makeTools"));
    expect(re.test("export function makeTools(deps) {")).toBe(true);
    expect(re.test("const makeTools = () => {}")).toBe(true);
    expect(re.test("makeToolsHelper()")).toBe(false); // substring, not a declaration
    expect(re.test("  makeTools(deps)")).toBe(false); // a call site, not a declaration
  });

  test("parses file:line:text grep output", () => {
    const m = parseDefMatches("src/a.ts:12:export function foo() {\nsrc/b.ts:3:const foo = 1\n");
    expect(m).toEqual([
      { file: "src/a.ts", line: 12, text: "export function foo() {" },
      { file: "src/b.ts", line: 3, text: "const foo = 1" },
    ]);
  });
});

describe("test-output parsing", () => {
  test("bun: pass + fail counts", () => {
    expect(parseTestOutput("\n 30 pass\n 2 fail\nRan 32 tests")).toEqual({ passed: 30, failed: 2, failing: [] });
  });
  test("bun: collects failing names", () => {
    const t = parseTestOutput("(fail) does the thing\n 5 pass\n 1 fail\n");
    expect(t?.failed).toBe(1);
    expect(t?.failing).toContain("does the thing");
  });
  test("jest summary", () => {
    expect(parseTestOutput("Tests: 2 failed, 5 passed, 7 total")).toMatchObject({ passed: 5, failed: 2 });
  });
  test("pytest summary line", () => {
    expect(parseTestOutput("==== 3 passed, 1 failed in 0.12s ====")).toMatchObject({ passed: 3, failed: 1 });
  });
  test("non-test output is not a test log", () => {
    expect(parseTestOutput("Compiled successfully.\nemitted 4 files")).toBeNull();
  });
});

describe("test_summary filter", () => {
  test("compresses a long failing log and emits the signal", () => {
    const log = `${"x".repeat(2000)}\n(fail) my broken test\n 9 pass\n 1 fail\n`;
    const r = testFilter.filter!(log);
    expect(r.applied).toBe(true);
    expect(r.text.length).toBeLessThan(log.length);
    expect(r.text).toContain("9 passed, 1 failed");
    expect(r.text).toContain("my broken test");
    expect(r.signal).toEqual({ kind: "tests", passed: false, failed: 1, total: 10 });
  });

  test("keeps the failure detail (assertion + file:line), not just counts", () => {
    const log = [
      "x".repeat(1600), // passing noise that should be dropped
      " FAIL  src/app/tasks/page.test.tsx > renders all tab triggers",
      " AssertionError: expected 3 to be 4",
      "    at src/app/tasks/page.test.tsx:42:20",
      " 9 pass",
      " 1 fail",
    ].join("\n");
    const r = testFilter.filter!(log);
    expect(r.applied).toBe(true);
    expect(r.text.length).toBeLessThan(log.length); // compressed the passing noise…
    expect(r.text).toContain("AssertionError: expected 3 to be 4"); // …but kept the assertion
    expect(r.text).toContain("page.test.tsx:42:20"); // …and the file:line
  });

  test("keeps short logs verbatim but still extracts the signal", () => {
    const log = " 3 pass\n 0 fail\n";
    const r = testFilter.filter!(log);
    expect(r.text).toBe(log); // short → keep the detail
    expect(r.signal).toEqual({ kind: "tests", passed: true, failed: 0, total: 3 });
  });

  test("passes non-test output straight through", () => {
    const r = testFilter.filter!("just some build output");
    expect(r.applied).toBe(false);
    expect(r.text).toBe("just some build output");
    expect(r.signal).toBeUndefined();
  });
});
