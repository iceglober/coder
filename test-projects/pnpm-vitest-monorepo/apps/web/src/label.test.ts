import { expect, test } from "vitest";
import { countBadge } from "./label.ts";

test("countBadge wraps a positive count", () => {
  expect(countBadge(3)).toBe("(3)");
});

test("countBadge is empty for zero", () => {
  expect(countBadge(0)).toBe("");
});
