import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify, dispatch, escalate, recognizeIntent } from "../src/router/index.ts";
import { shapeProse, verbosityRatio, VERBOSITY_SPIKE_THRESHOLD } from "../src/succinctness/index.ts";

const deps = {
  operationNames: new Set(["pr_status"]),
  matchOperation: (text: string) => (text.includes("pr") ? "pr_status" : undefined),
};

describe("dispatcher", () => {
  test("match routes to a deterministic operation (0 tokens)", () => {
    const d = classify("what's the pr status", deps);
    expect(d.classification).toBe("operation");
    expect(d.operation).toBe("pr_status");
  });

  test("slash routes to command bar", () => {
    expect(classify("/distill now", deps)).toMatchObject({ classification: "command", command: "distill" });
  });

  test("free-text starts at the cheapest tier", () => {
    expect(classify("refactor the auth module", deps)).toMatchObject({ classification: "free-text", tier: "cheap" });
  });

  test("escalation walks tiers and saturates at deep", () => {
    expect(escalate("cheap")).toBe("fast");
    expect(escalate("deep")).toBe("deep");
  });
});

describe("intent recognition (explicit slash commands only)", () => {
  test("slash commands route to a deterministic op", () => {
    expect(recognizeIntent("/git-state")).toEqual({ kind: "git_state" });
    expect(recognizeIntent("/status")).toEqual({ kind: "git_state" });
    expect(recognizeIntent("/read package.json")).toEqual({ kind: "read_file", arg: "package.json" });
    expect(recognizeIntent("/read src/a.ts")).toEqual({ kind: "read_file", arg: "src/a.ts" });
  });

  test("free-text prose is NOT guessed — it goes to the model", () => {
    for (const q of ["what branch am I on?", "read the readme", "git status", "refactor the auth module"]) {
      expect(recognizeIntent(q)).toBeNull();
    }
  });

  test("unknown or arg-less commands fall through to the model", () => {
    expect(recognizeIntent("/frobnicate")).toBeNull();
    expect(recognizeIntent("/read")).toBeNull();
  });
});

describe("dispatch execution", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "coder-dispatch-"));
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "README.md"), "THE-ONLY-READObserved");
    await writeFile(join(root, "a.ts"), "x");
    await writeFile(join(root, "b.ts"), "y");
    Bun.spawnSync(["git", "init", "-q"], { cwd: root });
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("git_state renders a structured answer (no model)", async () => {
    const r = await dispatch({ kind: "git_state" }, { worktreeRoot: root });
    expect("answer" in r && r.answer).toContain("On branch");
  });

  test("read_file resolves a unique nested file by name and returns its content", async () => {
    const r = await dispatch({ kind: "read_file", arg: "readme" }, { worktreeRoot: root });
    expect("answer" in r && r.answer).toContain("docs/README.md");
    expect("answer" in r && r.answer).toContain("THE-ONLY-READObserved");
  });

  test("ambiguous or missing file → escalate to the model", async () => {
    expect(await dispatch({ kind: "read_file", arg: "nope" }, { worktreeRoot: root })).toEqual({ escalate: true });
    // 'a.ts' and 'b.ts' both prefix-match 't'? no — but two .ts files: ask for a generic stem
    await writeFile(join(root, "config.json"), "{}");
    await writeFile(join(root, "config.yaml"), "{}");
    expect(await dispatch({ kind: "read_file", arg: "config" }, { worktreeRoot: root })).toEqual({ escalate: true });
  });
});

describe("succinctness", () => {
  test("response shaping strips prose but never code/diffs", () => {
    expect(shapeProse("Sure! Done.")).toBe("Done.");
    const code = "```ts\nconst x = 1\n```";
    expect(shapeProse(code)).toBe(code);
  });

  test("verbosity ratio flags a spike", () => {
    expect(verbosityRatio(300, 100)).toBeGreaterThan(VERBOSITY_SPIKE_THRESHOLD);
    expect(verbosityRatio(100, 100)).toBe(1);
  });
});
