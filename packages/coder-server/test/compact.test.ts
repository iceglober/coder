import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { compactHistory, estimateTokens } from "../src/context/compact.ts";

const summarizer = (t: string) =>
  new MockLanguageModelV3({
    // biome-ignore lint/suspicious/noExplicitAny: mock result shaped per the provider spec; bypass the strict union.
    doGenerate: async (): Promise<any> => ({
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 5, text: undefined, reasoning: undefined },
      },
      content: [{ type: "text", text: t }],
      warnings: [],
    }),
  });

/** A history big enough to trip the byte budget. */
function bigHistory(turns: number): ModelMessage[] {
  const msgs: ModelMessage[] = [];
  for (let i = 0; i < turns; i++) {
    msgs.push({ role: "user", content: `question ${i} ${"x".repeat(400)}` });
    msgs.push({ role: "assistant", content: `answer ${i} ${"y".repeat(400)}` });
  }
  return msgs;
}

describe("history compaction", () => {
  test("under budget: no-op, no model call", async () => {
    const history: ModelMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    const res = await compactHistory(history, { model: summarizer("SHOULD NOT RUN"), maxTokens: 10000, keepRecent: 6 });
    expect(res.compacted).toBe(false);
    expect(res.messages).toBe(history); // same reference — untouched
  });

  test("over budget: older turns become one summary; recent kept verbatim", async () => {
    const history = bigHistory(20); // 40 messages, well over the byte budget
    const keepRecent = 6;
    const res = await compactHistory(history, { model: summarizer("COMPACT SUMMARY"), maxTokens: 2000, keepRecent });

    expect(res.compacted).toBe(true);
    expect(res.after).toBeLessThan(res.before); // net token saver
    // [summary, ...last 6 verbatim]
    expect(res.messages.length).toBe(keepRecent + 1);
    expect(res.messages[0].content).toContain("COMPACT SUMMARY");
    expect(res.messages.at(-1)).toEqual(history.at(-1) as ModelMessage); // last turn preserved exactly
  });

  test("summarizer failure falls back to the full history (never drops it silently)", async () => {
    const history = bigHistory(20);
    const boom = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error("model down");
      },
    });
    const res = await compactHistory(history, { model: boom, maxTokens: 2000, keepRecent: 6 });
    expect(res.compacted).toBe(false);
    expect(res.messages).toBe(history); // safe: unchanged
  });

  test("estimateTokens grows with content", () => {
    expect(estimateTokens([{ role: "user", content: "x".repeat(400) }])).toBeGreaterThan(
      estimateTokens([{ role: "user", content: "x" }]),
    );
  });
});
