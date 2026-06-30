import { expect, test } from "vitest";
import { formatUSD } from "./money.ts";

test("formats dollars and cents", () => {
  expect(formatUSD(1299)).toBe("$12.99");
});

test("pads cents to two digits", () => {
  expect(formatUSD(1205)).toBe("$12.05");
});

test("handles a whole-dollar amount", () => {
  expect(formatUSD(500)).toBe("$5.00");
});
