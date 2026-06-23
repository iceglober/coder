import { describe, expect, test } from "bun:test";
import { classify, escalate } from "../src/router/index.ts";
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
