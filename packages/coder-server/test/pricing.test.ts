import { describe, expect, test } from "bun:test";
import { costOf } from "../src/agent/models.ts";
import { _setCatalogForTest } from "../src/catalog/index.ts";

describe("costOf — catalog pricing with family fallback", () => {
  test("uses exact catalog pricing, honoring the >200k-context tier", () => {
    _setCatalogForTest([
      {
        id: "gemini-3.1-pro-preview",
        provider: "google-vertex",
        cost: { input: 2, output: 12, over: { size: 200_000, input: 4, output: 18 } },
      },
    ]);
    // 100k input under 200k → base rate ($2/1M → $0.20)
    expect(costOf("gemini-3.1-pro-preview", { promptTokens: 100_000, completionTokens: 0 }, "vertex")).toBeCloseTo(0.2);
    // 300k input over 200k → higher tier ($4/1M → $1.20)
    expect(costOf("gemini-3.1-pro-preview", { promptTokens: 300_000, completionTokens: 0 }, "vertex")).toBeCloseTo(1.2);
  });

  test("falls back to the family table when the catalog lacks the model", () => {
    _setCatalogForTest([]); // loaded but empty
    // gemini-2.5-pro → gemini-pro family ($1.25 in)
    expect(costOf("gemini-2.5-pro", { promptTokens: 1_000_000, completionTokens: 0 }, "vertex")).toBeCloseTo(1.25);
  });

  test("no provider → family table (e.g. mock/tests)", () => {
    _setCatalogForTest([{ id: "x", provider: "google-vertex", cost: { input: 99, output: 99 } }]);
    // without a provider key we can't index the catalog → family fallback for a flash id
    expect(costOf("gemini-2.5-flash", { promptTokens: 1_000_000, completionTokens: 0 })).toBeCloseTo(0.3);
  });
});
