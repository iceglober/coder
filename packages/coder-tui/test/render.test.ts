import { describe, expect, test } from "bun:test";
import { renderCost } from "../src/render.ts";

describe("renderCost", () => {
  test("formats a normal cost line", () => {
    const out = renderCost(0.0012, 100, 20);
    expect(out).toContain("$0.0012");
    expect(out).toContain("in 100 / out 20");
  });

  // Vertex can omit token counts → NaN on the server → null over JSON. Must not crash.
  test("tolerates null and NaN without throwing", () => {
    expect(() => renderCost(null, null, null)).not.toThrow();
    expect(renderCost(null, null, null)).toContain("$?");
    expect(renderCost(Number.NaN, 5, 3)).toContain("$?");
  });
});
